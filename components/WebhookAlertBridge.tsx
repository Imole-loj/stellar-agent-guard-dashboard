"use client";

/**
 * Watches the guard's live state and dispatches webhooks when a configured
 * threshold is crossed (issue #141).
 *
 * This is the whole of the alerting logic's caller: it holds no policy of its
 * own, reads the conditions the console already reads, and hands them to
 * `webhookDispatcher`, which decides whether an event is due. Keeping the
 * decision in the pure module is what lets the tests cover "a frozen guard paged
 * once, not once per poll" without a browser.
 *
 * It renders nothing. A dispatch failure is reported through the toast-free
 * `announce` channel rather than a banner, because a console that cannot reach
 * the webhook must not also cover the panel the operator is trying to work in —
 * the settings dialog's "Test webhook" is where a delivery problem is
 * diagnosed.
 */

import { useContext, useEffect, useMemo, useRef } from "react";
import { GuardEventsContext, useGuard } from "./GuardProvider.tsx";
import { evaluateDmsAlert } from "../lib/guard/dmsAlert.ts";
import type { TelemetryEvent } from "../lib/guard/telemetry.ts";
import { NETWORK } from "../lib/guard/network.ts";
import { defaultGuardLabel } from "../lib/guard/instance.ts";
import { announce } from "../lib/guard/useAnnounce.ts";
import {
  buildWebhookPayload,
  countBlockedInWindow,
  createWebhookTriggerTracker,
  dispatchWebhook,
  dueWebhookEvents,
  isGuardScopedForDelivery,
  loadWebhookSettings,
  subscribeWebhookSettings,
  webhookEventsFor,
  type WebhookEventType,
  type WebhookSettings,
} from "../lib/guard/webhookDispatcher.ts";

/**
 * The stable empty list used when there is no feed context.
 *
 * A module-level constant rather than an inline `?? []`, because a fresh array
 * on every render would change the effect's dependencies and re-run the trigger
 * check on every render of the panel.
 */
const NO_EVENTS: readonly TelemetryEvent[] = [];

export function WebhookAlertBridge() {
  const { snapshot, guard, activeInstance } = useGuard();
  // Read through the context directly rather than `useGuardEvents`, which throws
  // outside a provider: the feed is an input to one of three conditions, and a
  // missing feed is a missing *input*, not a reason to fail rendering. An absent
  // context yields no refusals counted, so the block alert simply cannot fire —
  // which is the honest reading, since the console has not seen any.
  const events = useContext(GuardEventsContext) ?? NO_EVENTS;
  const settingsRef = useRef<WebhookSettings | null>(null);
  if (settingsRef.current === null) settingsRef.current = loadWebhookSettings();
  // One tracker for the tab's lifetime: it holds the previous observation, and
  // replacing it would re-arm every edge and page once per remount.
  const tracker = useMemo(() => createWebhookTriggerTracker(), []);
  // Timestamps of the last dispatch per event type — the cooldown's memory. In
  // memory, not storage: a console reloaded mid-incident should be free to
  // alert again rather than inherit a cooldown from a previous session.
  const lastSentAt = useRef<Partial<Record<WebhookEventType, number>>>({});

  useEffect(
    () =>
      subscribeWebhookSettings(() => {
        settingsRef.current = loadWebhookSettings();
      }),
    [],
  );

  // A guard switch makes every previous observation irrelevant: the new guard's
  // state is not a transition from the old one's, so the tracker forgets rather
  // than comparing two different accounts.
  useEffect(() => {
    tracker.reset();
    lastSentAt.current = {};
  }, [guard, tracker]);

  // Runs on every successful snapshot and every feed batch. Both are the
  // conditions changing; nothing here polls on its own.
  useEffect(() => {
    const settings = settingsRef.current;
    if (settings === null || !settings.enabled) return;
    if (!isGuardScopedForDelivery(settings, guard, NETWORK.name)) return;
    // Two dispatches for the same event cannot race: the tracker has already
    // consumed this edge, so the next pass sees the condition as unchanged and
    // produces nothing to send.
    const conditions = {
      adminFrozen: snapshot?.status.ok ? snapshot.status.value.admin_frozen : null,
      dms:
        snapshot && snapshot.status.ok
          ? evaluateDmsAlert(
              snapshot.status.value,
              snapshot.policy.ok ? snapshot.policy.value : null,
            )
          : null,
      blockedCount: countBlockedInWindow(events, settings.blockWindowSecs, Date.now()),
    };
    const now = Date.now();
    // Threshold first, then cooldown, then edge detection — the order matters:
    // the tracker has to see the *due* set, or a suppressed repeat would be
    // recorded as an observed condition and the real transition would be lost.
    const due = dueWebhookEvents({
      settings,
      events: webhookEventsFor(settings, conditions),
      guard,
      network: NETWORK.name,
      lastSentAt: lastSentAt.current,
      nowMs: now,
    });
    const entered = tracker.entered(due);
    if (entered.length === 0) return;

    for (const event of entered) {
      const payload = buildWebhookPayload(
        {
          event,
          guard,
          network: NETWORK.name,
          guardLabel: activeInstance?.label ?? defaultGuardLabel(guard),
          timestamp: new Date(now).toISOString(),
          details: buildDetails(event, conditions),
        },
        settings.secret,
      );
      void dispatchWebhook(payload, settings)
        .then((result) => {
          // Only a delivery that actually happened arms the cooldown: a failed
          // POST must stay eligible so the next poll can try again rather than
          // waiting out a cooldown for an alert that was never sent.
          if (result.ok) lastSentAt.current[event] = now;
          announce(
            result.ok
              ? `Webhook dispatched: ${event}`
              : `Webhook not sent (${event}): ${result.error ?? result.outcome}`,
            result.ok ? "polite" : "assertive",
          );
        })
        .catch(() => {
          // `dispatchWebhook` reports failures as values; this only guards
          // against a throw from something outside it, so the console keeps
          // running either way.
        });
    }
  }, [snapshot, events, guard, tracker, activeInstance?.label]);

  return null;
}

/** The event-specific fields a receiver needs, at the moment it fired. */
function buildDetails(
  event: WebhookEventType,
  conditions: {
    adminFrozen: boolean | null;
    dms: ReturnType<typeof evaluateDmsAlert> | null;
    blockedCount: number;
  },
): Record<string, string | number | boolean | null> {
  if (event === "FREEZE_ACTIVATED") {
    return {
      admin_frozen: conditions.adminFrozen,
      source: "status().admin_frozen",
    };
  }
  if (event === "DMS_EXPIRING") {
    const dms = conditions.dms;
    return {
      level: dms?.level ?? null,
      remaining_secs: dms?.remainingSecs ?? null,
      total_secs: dms?.totalSecs ?? null,
      fraction_remaining:
        dms?.fractionRemaining === null || dms === null
          ? null
          : Number(dms.fractionRemaining.toFixed(4)),
      expires_at_ms: dms?.expiresAtMs ?? null,
    };
  }
  return {
    blocked_count: conditions.blockedCount,
    source: "telemetry feed",
  };
}

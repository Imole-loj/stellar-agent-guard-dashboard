"use client";

/**
 * Opt-in auditory and visual alerts for security-critical telemetry (issue #90).
 *
 * The whole feature is a set of refusals, and they are the interesting part:
 *
 *   - It starts silent. Both channels are off until the operator turns them on,
 *     and the state is persisted, so an alert system never ambushes anyone.
 *   - It cannot make noise before a click. `AudioAlerter` is unlocked from the
 *     toggle's own handler — the browser's autoplay rule means a context created
 *     in an effect stays suspended, and a suspended context fails silently,
 *     which is the worst possible failure for an alert.
 *   - It only interrupts for events worth interrupting for. The matching lives
 *     in `lib/guard/audioAlert.ts` and is tested there; this component just
 *     asks each new feed event whether it earns a chime.
 *   - It does not stack. `requireInteraction` plus a stable `tag` means five
 *     blocks in ten seconds are one notification, not five. And one block
 *     re-polled by the feed is one alert, not one per poll (#313).
 *   - It says what it can actually do. The switch is the operator's preference;
 *     the browser's permission and the last delivery are two separate facts, and
 *     the panel states all three instead of implying that an enabled switch is
 *     a working alert (#314).
 *
 * Mounted inside the telemetry panel rather than the page, so the control sits
 * next to the feed whose events it announces.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GuardEvent } from "stellar-agent-guard-sdk";
import { useGuard, useGuardEvents } from "./GuardProvider.tsx";
import { short } from "./bits.tsx";
import { NETWORK } from "../lib/guard/network.ts";
import {
  AudioAlerter,
  ALERT_DEDUPE_PERSIST_LIMIT,
  alertDedupeScopeKey,
  alertsArmed,
  alertReasonFor,
  audioEffective,
  buildNotificationPayload,
  createAlertTracker,
  deliverNotification,
  desktopEffective,
  describeAudioEffective,
  describeDesktopEffective,
  describeNotificationDelivery,
  loadAlertDedupe,
  loadAlertSettings,
  notificationPermissionState,
  readBrowserNotificationApi,
  requestNotificationPermission,
  saveAlertDedupe,
  saveAlertSettings,
  type AlertDedupeScope,
  type AlertSettings,
  type AudioPlayReport,
  type NotificationDelivery,
  type NotificationPermissionState,
} from "../lib/guard/audioAlert.ts";

const REASON_LABEL: Record<NonNullable<ReturnType<typeof alertReasonFor>>, string> = {
  blocked: "a call was blocked",
  frozen: "the account was frozen",
  policy_revoked: "a policy was revoked",
};

export function TelemetryAlerts() {
  const events = useGuardEvents();
  const { guard, feed } = useGuard();
  const [settings, setSettings] = useState<AlertSettings>({
    audio: false,
    desktop: false,
    volume: 0.4,
  });
  const [permission, setPermission] = useState<NotificationPermissionState>("unsupported");
  const [lastAlert, setLastAlert] = useState<string | null>(null);
  // The two things the panel can only know by trying (#314): what the browser
  // did with the last notification, and whether the last chime actually played.
  const [lastDelivery, setLastDelivery] = useState<NotificationDelivery | null>(null);
  const [lastPlay, setLastPlay] = useState<AudioPlayReport | null>(null);

  // One alerter and one seen-set per tab. The alerter owns the AudioContext, so
  // recreating it on a re-render would drop the unlocked state and go silent
  // again without saying so.
  const alerter = useMemo(() => AudioAlerter.forBrowser(), []);
  const notificationApi = useMemo(() => readBrowserNotificationApi(), []);

  // The seen-set lives in a ref for the same reason: `feed.guards` is a fresh
  // array on every poll, so a `useMemo` keyed on it would rebuild the tracker
  // every five seconds and re-chime the block it just announced. It is replaced
  // only when the *scope* changes, below (#313).
  const trackerRef = useRef(createAlertTracker());
  const scopedKeyRef = useRef<string | null>(null);

  const scope = useMemo<AlertDedupeScope>(
    () => ({
      network: NETWORK.name,
      guards: [guard, ...feed.guards.map((source) => source.guard)],
    }),
    [guard, feed.guards],
  );
  const scopeKey = alertDedupeScopeKey(scope);

  // Settings and permission are only knowable in the browser, so both settle in
  // an effect. Rendering the stored value during the first render would produce
  // a hydration mismatch the moment an operator turned alerts on in a previous
  // session.
  useEffect(() => {
    // Named rather than inlined, matching `useAddressLabel`: the browser's state
    // is read in a callback, so hydration always shows the defaults.
    const restore = () => {
      setSettings(loadAlertSettings());
      setPermission(notificationPermissionState(notificationApi));
    };
    restore();
    return () => alerter.close();
  }, [alerter, notificationApi]);

  useEffect(() => {
    saveAlertSettings(settings);
  }, [settings]);

  // Fresh, security-critical events only. `trackerRef` is what keeps a 5s poll
  // from re-announcing the same block; without it a single refusal chimes once
  // per poll until it ages out of the feed.
  useEffect(() => {
    if (scopedKeyRef.current !== scopeKey) {
      // A different network or a different watched guard set is a different
      // stream of identities, so the memory is dropped and re-primed from that
      // scope's own record: switching never replays another scope's alerts, and
      // a reload never re-chimes this tab's history (#313).
      scopedKeyRef.current = scopeKey;
      trackerRef.current = createAlertTracker(ALERT_DEDUPE_PERSIST_LIMIT, loadAlertDedupe(scope));
    }
    const tracker = trackerRef.current;

    const announce = () => {
      if (!alertsArmed(settings)) return;
      const fresh = tracker.unseen(events).filter((event) => alertReasonFor(event) !== null);
      if (fresh.length === 0) return;

      for (const event of fresh) {
        const reason = alertReasonFor(event);
        if (!reason) continue;
        if (settings.audio) setLastPlay(alerter.play());
        if (settings.desktop) {
          setLastDelivery(
            deliverNotification(buildNotificationPayload(event, guard), notificationApi),
          );
        }
      }
      // The identities survive a reload only if they are written down; the
      // write is best-effort (private mode and quota are handled in the store).
      saveAlertDedupe(scope, tracker.keys());

      const newest = fresh[fresh.length - 1] as GuardEvent;
      const newestReason = alertReasonFor(newest);
      if (newestReason) setLastAlert(`${REASON_LABEL[newestReason]} · ${short(guard, 6, 4)}`);
    };
    announce();
  }, [events, settings, scope, scopeKey, alerter, guard, notificationApi]);

  /** Turn the chime on. The click is what unlocks audio, so this cannot be a checkbox. */
  const toggleAudio = useCallback(() => {
    setSettings((current) => {
      const next = { ...current, audio: !current.audio };
      if (next.audio) {
        const status = alerter.unlock();
        if (status === "unsupported") {
          setLastAlert("This browser has no Web Audio, so chimes are unavailable.");
          return { ...current, audio: false };
        }
        setLastPlay(alerter.play());
      }
      return next;
    });
  }, [alerter]);

  const toggleDesktop = useCallback(() => {
    // A new preference is a new question, so the previous answer stops being
    // the one on screen: an old delivery failure would otherwise read as a
    // broken channel the operator has just re-enabled.
    setLastDelivery(null);
    setSettings((current) => {
      const next = { ...current, desktop: !current.desktop };
      if (next.desktop) {
        void requestNotificationPermission(notificationApi).then((state) => {
          setPermission(state);
          if (state !== "granted") {
            setSettings((latest) => ({ ...latest, desktop: false }));
            setLastAlert(
              state === "unsupported"
                ? "This browser does not offer desktop notifications."
                : "Notifications were not granted, so the desktop channel stays off.",
            );
          }
        });
      }
      return next;
    });
  }, [notificationApi]);

  const desktopState = desktopEffective(settings.desktop, permission, lastDelivery);
  const audioState = audioEffective(settings.audio, lastPlay);
  const armed = alertsArmed(settings);

  return (
    <div
      className="row"
      style={{ justifyContent: "space-between", alignItems: "flex-start" }}
      data-testid="telemetry-alerts"
    >
      <div>
        <div className="row">
          <span className="lbl" style={{ margin: 0 }}>
            Security alerts
          </span>
          <span className={`pill${armed ? " ok" : ""}`}>{armed ? "armed" : "off"}</span>
        </div>
        <p className="tiny muted" style={{ marginTop: 4 }}>
          A short chime and a desktop notification when the guard blocks a call, or when an admin
          freezes the account or revokes a policy. Off until you turn it on.
        </p>
        <p className="tiny muted" style={{ marginTop: 4 }} data-testid="chime-alert-state">
          {describeAudioEffective(audioState)}
        </p>
        <p className="tiny muted" style={{ marginTop: 4 }} data-testid="desktop-alert-state">
          {describeDesktopEffective(desktopState)}
        </p>
        {lastDelivery && (
          <p
            className={lastDelivery.delivered ? "tiny muted" : "tiny"}
            style={
              lastDelivery.delivered ? { marginTop: 4 } : { marginTop: 4, color: "var(--danger)" }
            }
            data-testid="notification-delivery"
          >
            {describeNotificationDelivery(lastDelivery)}
          </p>
        )}
        {lastAlert && (
          <p className="tiny" style={{ marginTop: 4 }}>
            Last alert: {lastAlert}
          </p>
        )}
      </div>

      <div style={{ display: "grid", gap: 6, justifyItems: "end" }}>
        <button
          type="button"
          className={settings.audio ? undefined : "secondary"}
          onClick={toggleAudio}
          aria-pressed={settings.audio}
          title="Clicking is what lets the browser start audio"
        >
          {settings.audio ? "Mute chime" : "Enable chime"}
        </button>

        <button
          type="button"
          className={settings.desktop ? undefined : "secondary"}
          onClick={toggleDesktop}
          aria-pressed={settings.desktop}
          disabled={permission === "unsupported" || permission === "denied"}
          title={
            permission === "denied"
              ? "The browser has blocked notifications for this site; re-allow them in site settings."
              : "Asks the browser for notification permission"
          }
        >
          {settings.desktop ? "Disable notifications" : "Enable notifications"}
        </button>

        <label className="tiny muted row" style={{ gap: 6 }}>
          Volume
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={settings.volume}
            onChange={(event) => {
              const volume = Number(event.target.value);
              alerter.setVolume(volume);
              setSettings((current) => ({ ...current, volume }));
            }}
            aria-label="Alert chime volume"
          />
        </label>
      </div>
    </div>
  );
}

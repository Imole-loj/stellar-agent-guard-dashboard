"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { GuardStatus } from "stellar-agent-guard-sdk";
import type { rpc } from "@stellar/stellar-sdk";
import type { ReadResult } from "../lib/guard/chain.ts";
import {
  ACTIONS_HELD_ELSEWHERE,
  INCIDENT_VERDICT_PRESENTATION,
  compareIncidentRead,
  describeIncidentBasis,
  describeIncidentFlags,
  flagsFromStatus,
  incidentSituation,
  planIncidentActions,
  type GuardStatusView,
  type IncidentComparison,
  type IncidentOffer,
} from "../lib/guard/incidentActions.ts";
import { readSourceFor } from "../lib/guard/observerMode.ts";
import { evaluateOffline, useOnlineStatus } from "../lib/guard/online.ts";
import { useDemoMode } from "../lib/guard/useDemoMode.ts";
import { flagsFromSnapshot, type StatusFlags } from "../lib/guard/statusTransitions.ts";
import { announce } from "../lib/guard/useAnnounce.ts";
import { useGuard } from "./GuardProvider.tsx";

/**
 * The incident actions panel (#527).
 *
 * During an incident an operator needs three answers in one place: what can I
 * actually do to this account right now, what did the console look at to decide
 * that, and did the thing I did take effect. This panel is those three sections,
 * kept visibly apart because collapsing them is how a console talks an operator
 * into a wrong action:
 *
 *   - **Actions** lists only what the console can perform *and* the chain state
 *     makes meaningful, with a reason beside everything it left out. The rules
 *     live in `incidentActions.ts`; this file renders them.
 *   - **What this was decided from** carries the instant of the read behind the
 *     list. It is a separate block because an action list that looks current when
 *     it is four minutes old is the failure this section exists to prevent — and
 *     because freshness is not evidence that anything was changed.
 *   - **Verify on chain** is an explicit, operator-started re-read, which is the
 *     only thing here that can answer "did it land". It never runs on its own: a
 *     re-read that fires while a write is still in flight agrees with the old
 *     state, and an automatic agreement reads as a confirmation.
 *
 * It performs no write. Each action hands off to the control that already
 * performs it — focusing the existing button rather than clicking it, so the
 * confirmation that control requires stays unavoidable — and the panel says in
 * as many words which of those controls has a dialog and which goes straight to
 * the wallet prompt.
 */

/**
 * The read the verification block runs, injected for the same reason as
 * `PanicPanelOps`: what the panel says around a read is a property of the panel,
 * and a test must be able to check "a verification read that failed is never
 * shown as a reassuring verdict" without an RPC. The default is the real read,
 * loaded dynamically so `chain.ts` stays out of this panel's first-paint graph.
 */
export interface IncidentPanelOps {
  readStatus: (
    server: rpc.Server,
    guard: string,
    source?: string,
  ) => Promise<ReadResult<GuardStatus>>;
}

const DEFAULT_OPS: IncidentPanelOps = {
  readStatus: async (server, guard, source) =>
    (await import("../lib/guard/chain.ts")).readStatus(server, guard, source),
};

/** Freshness is a comparison against now, so the clock has to move (see #528). */
const CLOCK_TICK_MS = 5000;

interface Verification {
  comparison: IncidentComparison;
  seen: StatusFlags;
  /** When *this* read returned — never the page load, never the poll's stamp. */
  readAt: string;
  error: string | null;
  /** The guard this check ran against, so a switch cannot leave a stale verdict. */
  guard: string;
}

/**
 * The existing control a hand-off moves focus to, if it is on the page.
 *
 * Matched through `dataset` rather than an interpolated selector, so no caller
 * value reaches `querySelector`. The control may legitimately be absent: a
 * collapsed panel unmounts its content, and an open freeze dialog has replaced
 * the buttons with the modal.
 */
function existingIncidentControl(anchor: string): HTMLButtonElement | null {
  for (const candidate of Array.from(document.querySelectorAll("[data-incident-action]"))) {
    if ((candidate as HTMLElement).dataset.incidentAction !== anchor) continue;
    return candidate instanceof HTMLButtonElement ? candidate : null;
  }
  return null;
}

function viewOf(status: GuardStatus): GuardStatusView {
  return {
    adminFrozen: status.admin_frozen,
    heartbeatExpired: status.heartbeat_expired,
    hasPolicy: status.has_policy,
  };
}

export function IncidentPanel({ ops }: { ops?: Partial<IncidentPanelOps> }) {
  const { guard, server, wallet, observer, snapshot } = useGuard();
  const { readStatus } = { ...DEFAULT_OPS, ...ops };
  const demoMode = useDemoMode();
  const online = useOnlineStatus();

  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  // The same gate every other write control in the console uses — offline, or the
  // live read a write must preflight failed. Deciding it differently here would
  // let this panel offer what Emergency has already disabled.
  const offlineView = evaluateOffline({
    online,
    liveReadFailed: snapshot !== null && !snapshot.status.ok,
  });
  const preflightUnavailable = offlineView.writesDisabled ? offlineView.detail : null;

  const flags = flagsFromSnapshot(snapshot);
  const statusRead = snapshot?.status ?? null;

  // Neither of these is memoised: both are a handful of comparisons over three
  // booleans, and a memo whose inputs are recomputed every render (the snapshot
  // object is new on each poll) only adds a dependency list to keep honest.
  const plan = planIncidentActions({
    status: flags,
    walletConnected: !observer,
    preflightUnavailable,
  });

  const basis = describeIncidentBasis({
    readAt: statusRead !== null && statusRead.ok ? (statusRead.readAt ?? null) : null,
    error: statusRead !== null && !statusRead.ok ? statusRead.error : null,
    nowMs,
  });

  /*
   * Both replies below outlive the click that started them, so each carries the
   * guard it belongs to and the render drops it when the operator has moved on.
   * That is done at render rather than from an effect on `guard` because clearing
   * state in an effect is a second pass over the same render — and because a
   * check that belongs to a guard the operator no longer has selected is not
   * information about anything.
   */
  const [handoffMissed, setHandoffMissed] = useState<{ detail: string; guard: string } | null>(
    null,
  );
  const [verification, setVerification] = useState<Verification | null>(null);
  const [verifying, setVerifying] = useState(false);
  // Newest check wins: a reply that arrives after a newer one started, or after
  // unmount, is dropped rather than overwriting fresher state.
  const verifyToken = useRef(0);

  useEffect(
    () => () => {
      // Unmount invalidates whatever read is in flight, so its reply cannot
      // resurrect a panel the operator closed.
      verifyToken.current += 1;
    },
    [],
  );

  function takeHandoff(offer: IncidentOffer): void {
    if (offer.handoff.kind !== "focus") return;
    const target = existingIncidentControl(offer.handoff.anchor);
    if (target === null || target.disabled) {
      const detail =
        target === null
          ? `${offer.handoff.destination} is collapsed here, or its confirmation is already open.`
          : `${offer.handoff.destination} has disabled that control, and says why beside the button.`;
      setHandoffMissed({ detail, guard });
      announce(`${detail} Nothing was signed.`, "assertive");
      return;
    }
    setHandoffMissed(null);
    target.focus();
    announce(
      `Moved to ${offer.label.toLowerCase()} in ${offer.handoff.destination}. ` +
        "Activate it to complete the confirmation there. Nothing was signed.",
    );
  }

  async function verifyOnChain(): Promise<void> {
    const token = ++verifyToken.current;
    const checkedGuard = guard;
    const before: StatusFlags = flags;
    setVerifying(true);
    setVerification(null);
    try {
      const result = await readStatus(server, checkedGuard, readSourceFor(wallet));
      if (token !== verifyToken.current) return;
      const seen = result.ok ? flagsFromStatus(viewOf(result.value)) : flagsFromStatus(null);
      const comparison = compareIncidentRead(before, seen);
      setVerification({
        comparison,
        seen,
        readAt: new Date().toISOString(),
        error: result.ok ? null : result.error,
        guard: checkedGuard,
      });
      announce(
        result.ok
          ? `Verification read: ${comparison.words}`
          : `The verification read failed: ${result.error}`,
      );
    } catch (caught) {
      if (token !== verifyToken.current) return;
      const detail = caught instanceof Error ? caught.message : String(caught);
      const seen = flagsFromStatus(null);
      setVerification({
        comparison: compareIncidentRead(before, seen),
        seen,
        readAt: new Date().toISOString(),
        error: detail,
        guard: checkedGuard,
      });
      announce(`The verification read failed: ${detail}`);
    } finally {
      if (token === verifyToken.current) setVerifying(false);
    }
  }

  return (
    <div className="panel">
      <h2>Incident actions</h2>

      <p className="tiny muted">
        The admin writes this console can perform against the guard in front of you, limited to the
        ones the chain says are meaningful right now. Nothing here signs: each action moves you to
        the control that performs it and to the confirmation that control already requires.
      </p>

      <h3>Actions</h3>
      <p className="tiny" data-testid="incident-situation">
        {incidentSituation(flags)}
      </p>

      {plan.offers.length === 0 && (
        <p className="tiny muted" data-testid="incident-no-offers">
          No admin action is offered on this state. Every reason is listed below.
        </p>
      )}
      <ul className="incident-list" data-testid="incident-offers">
        {plan.offers.map((offer) => (
          <li key={offer.id} className="incident-row" data-incident-offer={offer.id}>
            <span className="incident-row-head">
              <strong>{offer.label}</strong>
              {offer.handoff.kind === "focus" ? (
                <button
                  type="button"
                  className="secondary"
                  onClick={() => takeHandoff(offer)}
                  title={`Moves focus to the existing control in ${offer.handoff.destination}. This panel signs nothing.`}
                >
                  Go to it in {offer.handoff.destination}
                </button>
              ) : (
                <Link
                  href={offer.handoff.href}
                  title={`The control lives on ${offer.handoff.destination}. This panel signs nothing.`}
                >
                  Open {offer.handoff.destination}
                </Link>
              )}
            </span>
            <span className="tiny muted">{offer.effect}</span>
            <span className="tiny">Confirmation it requires: {offer.confirmation}</span>
            {offer.unbackedByRead && (
              <span className="notice info tiny" data-testid="incident-unbacked">
                No status read has answered yet, so this row is not derived from chain state. The
                control itself re-reads before it signs.
              </span>
            )}
          </li>
        ))}
      </ul>

      {handoffMissed !== null && handoffMissed.guard === guard && (
        <p className="notice warn tiny" role="status" data-testid="incident-handoff-missed">
          {handoffMissed.detail} <Link href="/panic">Open the Emergency screen</Link> instead.
        </p>
      )}

      {plan.refusals.length > 0 && (
        <ul className="incident-list" data-testid="incident-refusals">
          {plan.refusals.map((refusal) => (
            <li key={refusal.id} className="incident-row" data-incident-refusal={refusal.id}>
              <span className="incident-row-head">
                <strong className="muted">{refusal.label}</strong>
                <span className="pill muted">not offered</span>
              </span>
              <span className="tiny muted">{refusal.reason}</span>
            </li>
          ))}
        </ul>
      )}

      <p className="tiny muted" data-testid="incident-elsewhere">
        Not performed from here:
        {ACTIONS_HELD_ELSEWHERE.map((action, index) => (
          <span key={action.label}>
            {index > 0 ? "; " : " "}
            {action.href === null ? (
              <span>
                {action.label} — {action.where}
              </span>
            ) : (
              <span>
                <Link href={action.href}>{action.label}</Link> — {action.where}
              </span>
            )}
          </span>
        ))}
        .
      </p>

      <h3>What this was decided from</h3>
      <p className="tiny" data-testid="incident-basis">
        {basis.kind === "read" && basis.readAt !== null ? (
          <time dateTime={basis.readAt}>{basis.words}</time>
        ) : (
          <span>{basis.words}</span>
        )}{" "}
        <span className="muted">
          That is what the console knew, not what your write did: a freeze that has not landed yet
          does not appear here. The header strip says when this panel next reads on its own.
        </span>
      </p>
      {basis.error !== null && (
        <p className="notice danger tiny" role="alert">
          Status read failed: {basis.error}
        </p>
      )}
      {demoMode && (
        <p className="notice info tiny" role="status" data-testid="incident-demo-caveat">
          Demo data: what is above is a fixture, not a chain read.
        </p>
      )}

      <h3>Verify on chain</h3>
      <p className="tiny muted">
        One read of <code>status()</code> for this guard, started by you, after you acted. It signs
        and submits nothing.
      </p>
      <div className="row" style={{ marginTop: 8 }}>
        <button
          type="button"
          className="secondary"
          onClick={() => void verifyOnChain()}
          disabled={verifying || demoMode}
          title={
            demoMode
              ? "Demo mode never reads the chain, so there is nothing to verify against."
              : "Reads status() once. It is the only block here that can answer whether a write landed."
          }
        >
          {verifying ? "Reading…" : "Verify on chain now"}
        </button>
      </div>

      {verification !== null && verification.guard === guard && (
        <div className="notice info tiny" data-testid="incident-verification">
          <p>
            <span
              className={`pill ${INCIDENT_VERDICT_PRESENTATION[verification.comparison.verdict].tone}`}
            >
              {INCIDENT_VERDICT_PRESENTATION[verification.comparison.verdict].words}
            </span>{" "}
            {verification.comparison.words}
          </p>
          {verification.error !== null && <p className="muted">Read error: {verification.error}</p>}
          <ul className="incident-list">
            {describeIncidentFlags(verification.seen).map((row) => (
              <li key={row.label} className="incident-row">
                <span className="incident-row-head">
                  <span>{row.label}</span>
                  <span className={row.unread ? "muted" : ""}>{row.words}</span>
                </span>
              </li>
            ))}
          </ul>
          <p className="muted">
            This read completed at <time dateTime={verification.readAt}>{verification.readAt}</time>{" "}
            for <code>{verification.guard}</code>.
          </p>
        </div>
      )}
    </div>
  );
}

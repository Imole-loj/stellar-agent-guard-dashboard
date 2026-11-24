/**
 * Which admin actions the incident panel may offer, decided from the chain (#527).
 *
 * A panel that hard-codes freeze / unfreeze / revoke is a row of buttons, not
 * help. It offers an unfreeze when nothing is frozen and a revoke when no policy
 * is installed, and — worse — every action it leaves out is silent about *why*:
 * "not needed", "not performed from this console" and "could not be worked out"
 * look identical to an operator in the middle of an incident. So this module
 * takes what the live read actually answered and returns a partition — every
 * action is either offered or refused with a reason, never simply absent.
 *
 * Three rules shape it, and each one exists to stop a specific way the panel
 * could lie:
 *
 *   1. **Supported-only, and the exclusions are named.** The console performs
 *      three admin writes: freeze, unfreeze, revoke policy. Installing or
 *      adjusting a policy and rotating the agent key live on other screens, and
 *      a heartbeat comes from the agent process, not the dashboard. Those are
 *      {@link ACTIONS_HELD_ELSEWHERE} — stated, not omitted.
 *   2. **Nothing here signs, and nothing here adds a gate.** An offer is a
 *      hand-off: it names the control that already performs the write, and the
 *      confirmation *that control already requires* is printed verbatim. The
 *      panel opens no second dialog and never bypasses the first, because two
 *      confirmations that disagree about what they cover are worse than one.
 *   3. **The live read gates every write, including freeze.** A status read that
 *      failed is passed to {@link planIncidentActions} as `preflightUnavailable`,
 *      the same sentence the Emergency panel's disabled button carries
 *      (`online.ts` → `evaluateOffline`, issue #348). An incident panel offering
 *      freeze while that button is inert would be the console contradicting
 *      itself at the worst possible moment — so the asymmetry people expect
 *      ("surely the safe action survives an unknown state?") is deliberately
 *      *not* taken here: the action stays available where it is actually
 *      performed, with its own error surface, rather than being offered from a
 *      panel that cannot see the chain either. The one window where an offer has
 *      no read behind it is before the first read has landed at all, which is
 *      how Emergency already behaves; that offer is marked `unbackedByRead` so
 *      the panel can say so instead of implying it checked.
 *
 * Pure and React-free, as everywhere in `lib/guard`: the partition is the part
 * worth testing, and a test must be able to assert "already frozen refuses a
 * freeze" without mounting a component or faking an RPC.
 */

import { WRITE_DISABLED_HINT } from "./observerMode.ts";
import type { StatusFlags } from "./statusTransitions.ts";
import { sinceWords } from "./time.ts";

/** An admin write the console is able to perform. */
export type IncidentActionId = "freeze" | "unfreeze" | "revoke-policy";

/** Every action the panel reasons about, in the order it speaks about them. */
export const INCIDENT_ACTION_IDS: readonly IncidentActionId[] = [
  "freeze",
  "unfreeze",
  "revoke-policy",
];

/**
 * The `data-incident-action` value carried by the existing Emergency controls.
 *
 * A hand-off focuses these rather than clicking them: the operator still starts
 * the write themselves, so the existing confirmation is unavoidable, and the
 * panel cannot cause a signature by being clicked.
 */
export const INCIDENT_FREEZE_ANCHOR = "freeze";
export const INCIDENT_UNFREEZE_ANCHOR = "unfreeze";

/** Where the operator completes an offered action. */
export type IncidentHandoff =
  | {
      readonly kind: "focus";
      /** The console panel holding the existing control. */
      readonly panel: "panic";
      readonly anchor: string;
      readonly destination: string;
    }
  | {
      readonly kind: "route";
      readonly href: string;
      readonly destination: string;
    };

/** An action the operator may take right now, and what taking it involves. */
export interface IncidentOffer {
  id: IncidentActionId;
  label: string;
  /** What the write does to the guarded account, in the operator's words. */
  effect: string;
  /**
   * The confirmation the *existing* control already requires — including the
   * honest "there is no dialog, the wallet prompt is the confirmation" case.
   */
  confirmation: string;
  handoff: IncidentHandoff;
  /**
   * True when no successful status read answered the flag this offer turns on.
   *
   * Only reachable before the first read lands (a failed read is gated by
   * `preflightUnavailable` above). The action is still supported — Emergency
   * preflights its own read before it signs — but the panel must not let this
   * row look like a chain-derived recommendation when it is a guess.
   */
  unbackedByRead: boolean;
}

/** An action the panel does not offer, with the reason it says out loud. */
export interface IncidentRefusal {
  id: IncidentActionId;
  label: string;
  reason: string;
}

export interface IncidentPlan {
  offers: IncidentOffer[];
  refusals: IncidentRefusal[];
}

export interface IncidentActionInput {
  /** The flags the most recent live status read answered (`null` = it did not answer). */
  status: StatusFlags;
  /** An admin wallet is connected, so a write could be signed at all. */
  walletConnected: boolean;
  /**
   * Non-null when no write can be prepared: the browser is offline, or the live
   * status read a write must preflight failed. The value is the sentence the
   * rest of the console uses, so the reasons cannot drift from the buttons.
   */
  preflightUnavailable: string | null;
}

const ACTION_LABELS: Record<IncidentActionId, string> = {
  freeze: "Freeze the account",
  unfreeze: "Unfreeze the account",
  "revoke-policy": "Revoke the policy",
};

const ACTION_EFFECTS: Record<IncidentActionId, string> = {
  freeze:
    "Sets the admin freeze, after which __check_auth refuses every call the account would make — the agent stops being able to move anything. Reversible.",
  unfreeze:
    "Clears the admin freeze and restarts the heartbeat clock, which is also the way back from a dead-man-switch freeze.",
  "revoke-policy":
    "Removes the installed policy, returning the account to default deny: nothing the agent asks for is allowed any more.",
};

/**
 * What stands between the existing control and a signature.
 *
 * Only freeze has a dialog; saying so for the other two is the point — an
 * operator who expects a second confirmation and gets none may not notice they
 * have already committed.
 */
const ACTION_CONFIRMATIONS: Record<IncidentActionId, string> = {
  freeze:
    "Emergency asks for an acknowledgement, and for the guard address typed back when the balance read says the exposure is large.",
  unfreeze:
    "Emergency submits on the click — the signature prompt in your wallet is the confirmation.",
  "revoke-policy":
    "Configure submits on the click — the signature prompt in your wallet is the confirmation.",
};

const ACTION_HANDOFFS: Record<IncidentActionId, IncidentHandoff> = {
  freeze: {
    kind: "focus",
    panel: "panic",
    anchor: INCIDENT_FREEZE_ANCHOR,
    destination: "Emergency",
  },
  unfreeze: {
    kind: "focus",
    panel: "panic",
    anchor: INCIDENT_UNFREEZE_ANCHOR,
    destination: "Emergency",
  },
  "revoke-policy": { kind: "route", href: "/configure", destination: "Configure" },
};

/** An admin action the console can perform somewhere other than this panel. */
export interface ExternalAction {
  label: string;
  where: string;
  /** The route that holds it, or null when the dashboard does not hold it at all. */
  href: string | null;
}

/**
 * What the panel will not do, each one naming where it is done instead.
 *
 * The heartbeat entry is the one with no destination: heartbeats are the agent's
 * own write, so "the dashboard cannot do this" is the whole answer, and saying
 * "somewhere else in the console" would be a invented link.
 */
export const ACTIONS_HELD_ELSEWHERE: readonly ExternalAction[] = [
  { label: "Install or adjust a policy", where: "Configure", href: "/configure" },
  { label: "Rotate the agent key", where: "Deploy", href: "/deploy" },
  {
    label: "Send a heartbeat",
    where: "the agent process — the dashboard has no heartbeat write",
    href: null,
  },
];

/**
 * Partition the admin actions into offered and refused-with-a-reason.
 *
 * The gates are checked in the order the operator can act on them: no wallet
 * (connect one), then no usable read (retry it or take the runbook), then the
 * chain state that decides whether the action means anything. The last block
 * treats `null` as not-applicable rather than assuming a value, so an input
 * where the read failed cannot produce an offer by accident.
 */
export function planIncidentActions(input: IncidentActionInput): IncidentPlan {
  const offers: IncidentOffer[] = [];
  const refusals: IncidentRefusal[] = [];

  const refuse = (id: IncidentActionId, reason: string): void => {
    refusals.push({ id, label: ACTION_LABELS[id], reason });
  };
  const refuseAll = (reason: string): IncidentPlan => {
    for (const id of INCIDENT_ACTION_IDS) refuse(id, reason);
    return { offers, refusals };
  };

  if (!input.walletConnected) return refuseAll(`${WRITE_DISABLED_HINT}.`);
  if (input.preflightUnavailable !== null) return refuseAll(input.preflightUnavailable);

  if (input.status.adminFrozen === true) {
    refuse(
      "freeze",
      "Chain reports the account is already admin-frozen — there is nothing to freeze.",
    );
  } else {
    offers.push(offer("freeze", input.status.adminFrozen === null));
  }

  if (input.status.adminFrozen === true) {
    offers.push(offer("unfreeze", false));
  } else {
    refuse(
      "unfreeze",
      input.status.adminFrozen === false
        ? "Chain reports the account is not frozen, so there is nothing to clear."
        : "The status read did not answer whether the account is frozen.",
    );
  }

  if (input.status.hasPolicy === true) {
    offers.push(offer("revoke-policy", false));
  } else {
    refuse(
      "revoke-policy",
      input.status.hasPolicy === false
        ? "No policy is installed, so the account is already in default deny."
        : "The status read did not answer whether a policy is installed.",
    );
  }

  return { offers, refusals };
}

function offer(id: IncidentActionId, unbackedByRead: boolean): IncidentOffer {
  return {
    id,
    label: ACTION_LABELS[id],
    effect: ACTION_EFFECTS[id],
    confirmation: ACTION_CONFIRMATIONS[id],
    handoff: ACTION_HANDOFFS[id],
    unbackedByRead,
  };
}

/**
 * One sentence on what the chain currently reports, ahead of any button.
 *
 * It states the observed flags rather than a diagnosis: the panel's job is to
 * tell the operator what the account is doing right now, in the same words the
 * status read uses, and leave the judgement to them.
 */
export function incidentSituation(status: StatusFlags): string {
  if (status.adminFrozen === null && status.heartbeatExpired === null) {
    return "No live status read yet — nothing below is backed by chain state.";
  }
  const parts: string[] = [];
  parts.push(
    status.adminFrozen === null
      ? "the admin freeze is unread"
      : status.adminFrozen
        ? "the account is admin-frozen, so every call the agent makes is refused"
        : "the account is not admin-frozen",
  );
  if (status.heartbeatExpired === true) {
    parts.push(
      "the dead-man switch has fired, which blocks agent activity until a heartbeat lands",
    );
  } else if (status.heartbeatExpired === false) {
    parts.push("the heartbeat is current");
  }
  if (status.hasPolicy === false) {
    parts.push("no policy is installed, so the account is in default deny");
  }
  return `Chain currently reports: ${parts.join("; ")}.`;
}

/** What the plan was derived from, stated separately from any write result. */
export interface IncidentBasis {
  kind: "read" | "failed" | "never";
  readAt: string | null;
  /** One sentence naming the instant the plan was decided from. */
  words: string;
  error: string | null;
}

/**
 * Describe the read the action list was decided from.
 *
 * `readAt` is the instant *this* read completed, not the page load: the panel
 * must be able to say "decided from a read 4 minutes ago" while the header says
 * the feed last polled 4 seconds ago, because those are different reads and
 * collapsing them would overstate how much the console knows.
 */
export function describeIncidentBasis(input: {
  readAt: string | null;
  error: string | null;
  nowMs: number;
}): IncidentBasis {
  if (input.error !== null) {
    return {
      kind: "failed",
      readAt: null,
      words: "The last status read failed, so the actions above were not decided from chain state.",
      error: input.error,
    };
  }
  if (input.readAt === null) {
    return {
      kind: "never",
      readAt: null,
      words:
        "No successful status read has completed yet, so nothing here is backed by chain state.",
      error: null,
    };
  }
  return {
    kind: "read",
    readAt: input.readAt,
    words: `Decided from a status read ${sinceWords(Date.parse(input.readAt), input.nowMs)}.`,
    error: null,
  };
}

/** The flags a status read answered, for the verification block. */
export interface GuardStatusView {
  adminFrozen: boolean;
  heartbeatExpired: boolean;
  hasPolicy: boolean;
}

/** How the re-read compares with the read the plan was decided from. */
export type IncidentVerdict = "changed" | "unchanged" | "incomplete" | "unread";

export interface IncidentComparison {
  verdict: IncidentVerdict;
  /** Human names of the flags that moved, in the order the panel lists them. */
  changed: string[];
  /** Human names of the flags one of the two reads did not answer. */
  uncomparable: string[];
  words: string;
}

const FLAG_LABELS: Record<keyof StatusFlags, string> = {
  adminFrozen: "admin freeze",
  heartbeatExpired: "dead-man switch",
  hasPolicy: "installed policy",
};

const FLAG_ORDER: readonly (keyof StatusFlags)[] = ["adminFrozen", "heartbeatExpired", "hasPolicy"];

/**
 * Compare the verification re-read with the read behind the plan.
 *
 * A flag counts as changed only when *both* reads answered it and they disagree
 * — the same discipline as `transitionsBetween`, for the same reason: a move
 * into or out of "unknown" is a read that failed, not a chain that changed, and
 * reporting it as a change would tell an operator their freeze landed when all
 * that happened is that a second read came back.
 *
 * `incomplete` exists because a partial comparison must never be read as "no
 * change". "Nothing contradicted" is not the same sentence as "verified".
 */
export function compareIncidentRead(before: StatusFlags, after: StatusFlags): IncidentComparison {
  if (after.adminFrozen === null && after.heartbeatExpired === null && after.hasPolicy === null) {
    return {
      verdict: "unread",
      changed: [],
      uncomparable: [],
      words: "The verification read failed, so nothing has been confirmed either way.",
    };
  }

  const changed: string[] = [];
  const uncomparable: string[] = [];
  for (const flag of FLAG_ORDER) {
    const was = before[flag];
    const now = after[flag];
    if (was === null || now === null) {
      uncomparable.push(FLAG_LABELS[flag]);
      continue;
    }
    if (was !== now) changed.push(`${FLAG_LABELS[flag]} ${now ? "set" : "cleared"}`);
  }

  if (changed.length > 0) {
    return {
      verdict: "changed",
      changed,
      uncomparable,
      words: `The re-read disagrees with the read these actions were decided from: ${changed.join(
        ", ",
      )}.`,
    };
  }
  if (uncomparable.length > 0) {
    return {
      verdict: "incomplete",
      changed,
      uncomparable,
      words: `Nothing the re-read answered disagrees, but it could not compare ${uncomparable.join(
        ", ",
      )}. That is not a confirmation.`,
    };
  }
  return {
    verdict: "unchanged",
    changed,
    uncomparable,
    words: "The re-read matches the read these actions were decided from.",
  };
}

/**
 * How a verdict is shown, decided here rather than in the panel so a test can
 * pin the one thing that matters: `unread` never gets a reassuring tone, and
 * `incomplete` never gets `ok`.
 *
 * `unchanged` is deliberately muted rather than green. The panel does not know
 * which write the operator performed, so "the re-read agrees with the earlier
 * read" can equally mean "your freeze did not land" — colouring it as success
 * would be exactly the overclaim this block exists to avoid.
 */
export const INCIDENT_VERDICT_PRESENTATION: Record<
  IncidentVerdict,
  { readonly words: string; readonly tone: "ok" | "warn" | "danger" | "muted" }
> = {
  changed: { words: "changed", tone: "warn" },
  unchanged: { words: "no change", tone: "muted" },
  incomplete: { words: "partly unread", tone: "warn" },
  unread: { words: "read failed", tone: "danger" },
};

/** One flag, spelled the way the panel lists it. */
export interface IncidentFlagRow {
  label: string;
  words: string;
  /** True when the read did not answer this flag — an absence, never a `false`. */
  unread: boolean;
}

/**
 * The three flags as rows, for the verification block.
 *
 * Deliberately colour-free: this list answers "what did that read say", and a
 * pill would turn a fact into a verdict. An unread flag is labelled as unread
 * rather than shown with the word a missing value would take.
 */
export function describeIncidentFlags(status: StatusFlags): IncidentFlagRow[] {
  return FLAG_ORDER.map((flag) => ({
    label: FLAG_LABELS[flag],
    words: flagWords(flag, status[flag]),
    unread: status[flag] === null,
  }));
}

function flagWords(flag: keyof StatusFlags, value: boolean | null): string {
  if (value === null) return "not read";
  switch (flag) {
    case "adminFrozen":
      return value ? "set" : "clear";
    case "heartbeatExpired":
      return value ? "expired" : "within grace";
    case "hasPolicy":
      return value ? "installed" : "none";
  }
}

/** The three flags of a `status()` reply, or all-`null` for a failed read. */
export function flagsFromStatus(status: GuardStatusView | null): StatusFlags {
  if (!status) return { adminFrozen: null, heartbeatExpired: null, hasPolicy: null };
  return {
    adminFrozen: status.adminFrozen,
    heartbeatExpired: status.heartbeatExpired,
    hasPolicy: status.hasPolicy,
  };
}

/**
 * The words the console speaks when an operator's own action finishes.
 *
 * Every string a screen reader hears for a *result* lives here, is spoken through
 * `announce()` — the single write chokepoint into the shell's live regions — and
 * is therefore greppable in one file. Keeping the copy out of the components is
 * what makes it an inventory: a translation pass (the i18n follow-up to #30) has
 * one module to walk instead of hunting through event handlers, and the tests can
 * assert that each template is still wired to the handler that owns the event.
 *
 * Two choices are fixed here rather than at the call sites, and both are
 * incident-detection choices:
 *
 *   1. A failure is announced assertively and always carries its reason. "Freeze
 *      failed" on its own tells a screen-reader operator only that something
 *      broke, which is strictly less than the reason the sighted operator reads
 *      on screen; the reason is the part that says what to do next.
 *   2. A success is announced only once the chain re-read confirms the effect.
 *      The write path already announces "transaction confirmed"; this is the
 *      announcement that the *effect* the operator asked for is on chain, which
 *      is the only claim the console is allowed to make (see `PanicPanel`).
 */

import type { AnnouncePriority } from "./useAnnounce.ts";
import type { InvokeResult } from "./submit.ts";

/** A message and the live region it is spoken into. */
export interface Spoken {
  message: string;
  priority: AnnouncePriority;
}

export type FreezeAction = "freeze" | "unfreeze";

export type PolicyOperation = "set_policy" | "revoke_policy";

/** The confirmed effect of each freeze action, in the operator's own words. */
const FREEZE_CONFIRMED: Record<FreezeAction, string> = {
  freeze: "Account frozen",
  unfreeze: "Account unfrozen",
};

/** The action as a sentence start, so a failure reads as a sentence. */
const ACTION_HEAD: Record<FreezeAction, string> = {
  freeze: "Freeze",
  unfreeze: "Unfreeze",
};

const POLICY_CONFIRMED: Record<PolicyOperation, string> = {
  set_policy: "Policy installed on chain",
  revoke_policy: "Policy revoked; the account is back to default deny",
};

const POLICY_HEAD: Record<PolicyOperation, string> = {
  set_policy: "Policy install",
  revoke_policy: "Policy revoke",
};

/**
 * The freeze landed and `status()` re-read confirms it.
 *
 * Polite, because the operator asked for it and is looking at the result: the
 * low-level write path has already announced the transaction itself, and a
 * second interruption for the same action would be noise.
 */
export function freezeConfirmed(action: FreezeAction, guard?: string): Spoken {
  return withGuard({ message: FREEZE_CONFIRMED[action], priority: "polite" }, guard);
}

/**
 * A freeze that was broadcast but never verified against `status()`.
 *
 * The fleet table freezes from a list of guards and holds no snapshot to re-read,
 * so the submission receipt is all the evidence there is. This is the only path
 * that announces a freeze assertively, and therefore the only place where one is
 * announced without a chain re-read behind it.
 */
export function freezeSubmitted(guard?: string): Spoken {
  return withGuard({ message: "Admin freeze activated", priority: "assertive" }, guard);
}

/**
 * The freeze did not take effect. `reason` is the operator-facing detail — the
 * contract's own words, the network's rejection, or the note explaining that the
 * re-read disagreed with the write.
 */
export function freezeFailed(action: FreezeAction, reason: string, guard?: string): Spoken {
  return withGuard(
    { message: `${ACTION_HEAD[action]} failed: ${reason}`, priority: "assertive" },
    guard,
  );
}

/** `set_policy` / `revoke_policy` landed. */
export function policyConfirmed(operation: PolicyOperation, guard?: string): Spoken {
  return withGuard({ message: POLICY_CONFIRMED[operation], priority: "polite" }, guard);
}

/** `set_policy` / `revoke_policy` was refused, rejected, or never completed. */
export function policyFailed(operation: PolicyOperation, reason: string, guard?: string): Spoken {
  return withGuard(
    { message: `${POLICY_HEAD[operation]} failed: ${reason}`, priority: "assertive" },
    guard,
  );
}

function withGuard(spoken: Spoken, guard?: string): Spoken {
  return guard ? { ...spoken, message: `${spoken.message} for guard ${guard}` } : spoken;
}

/**
 * Which half of an operator's mark they just touched (#482, #483).
 *
 * One record, two controls: a bookmark says "come back to this row" and a note says
 * "here is what I think about it". They are announced separately because the two
 * operators' intents differ, and a single "mark saved" would leave a note's author
 * unable to tell whether the text or the flag took.
 */
export type MarkKind = "bookmark" | "note";

/** A mark that was written, phrased as what was written. */
const MARK_SAVED: Record<MarkKind, string> = {
  bookmark: "Bookmarked in this browser",
  note: "Note saved in this browser",
};

/** The mark as a sentence start, so a failure reads as a sentence. */
const MARK_HEAD: Record<MarkKind, string> = {
  bookmark: "Bookmark",
  note: "Note",
};

/** The feed's table was frozen while polling carried on behind it. */
export function streamPaused(): Spoken {
  return {
    message: "Stream paused; the table is frozen while polling continues",
    priority: "polite",
  };
}

/** The queue was applied to the table, in order, with nothing dropped silently. */
export function streamResumed(added: number): Spoken {
  return {
    message:
      added === 0
        ? "Stream resumed; no events were queued"
        : `Stream resumed with ${added} queued event${added === 1 ? "" : "s"}`,
    priority: "polite",
  };
}

/**
 * A mark was written to this browser.
 *
 * Polite — the operator asked for it, and it changes nothing on chain. The wording
 * carries "in this browser" deliberately: #483's risk is a note being remembered as
 * something the guard recorded, so the sentence that confirms the save is the one
 * that says where it lives.
 *
 * `anchored: false` is the #482 distinction. A diagnostic row has no transaction and
 * no ledger, so unlike a committed row it cannot be re-read later — the bookmark is
 * a memory, not a pointer, and the operator is told that at the moment they make it
 * rather than when they come back and find nothing to open.
 */
export function markSaved(kind: MarkKind, anchored = true): Spoken {
  const message = MARK_SAVED[kind];
  return {
    message: anchored ? message : `${message}; this row has no ledger to re-read it from`,
    priority: "polite",
  };
}

/** The mark, or the last half of it, was deleted. */
export function markRemoved(kind: MarkKind): Spoken {
  return { message: `${MARK_HEAD[kind]} removed`, priority: "polite" };
}

/**
 * Nothing was written, and why. `reason` is the store's own diagnostic — the note
 * held a secret key, the row had no stable identity, or the guard's list is full.
 *
 * Assertive per rule 1 above: "not saved" on its own is strictly less than what the
 * sighted operator reads, and the reason is the part that says what to do next.
 */
export function markRejected(kind: MarkKind, reason: string): Spoken {
  return { message: `${MARK_HEAD[kind]} was not saved: ${reason}`, priority: "assertive" };
}

/**
 * The mark is live this session but was not written to storage, because the browser
 * refused the write. Distinct from a rejection: the operator's bookmark *is* on the
 * row and the "bookmarked only" filter will find it — it simply will not survive a
 * reload, which is a promise the panel must not quietly drop.
 */
export function markNotStored(kind: MarkKind, reason: string): Spoken {
  return {
    message: `${MARK_HEAD[kind]} not stored in this browser: ${reason}`,
    priority: "assertive",
  };
}

/**
 * The operator-facing reason a write did not take effect.
 *
 * Ordered by how much each one explains: what the enforced simulation refused
 * and why, then what the network rejected, then a transaction that was only
 * exported — nothing on chain changed, which is the whole point of saying so —
 * and finally the caller's own fallback, which is used for the cases the result
 * type cannot speak for: a write that was included but whose effect a `status()`
 * re-read contradicted.
 *
 * Shared by the freeze and policy paths so the same refusal is worded the same
 * way on both, and so "why did it fail" has one answer in the codebase instead
 * of one per handler.
 */
export function writeFailureReason(result: InvokeResult, fallback: string): string {
  if (result.kind === "refused") return `refused during ${result.stage}: ${result.detail}`;
  if (result.kind === "failed") return `the network rejected the transaction: ${result.detail}`;
  if (result.kind === "exported") {
    return "the transaction was only exported for offline signing, so nothing on chain changed";
  }
  return fallback;
}

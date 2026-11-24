/**
 * The incident panel's action decision (#527).
 *
 * The panel is only worth having if the partition it renders is the one the
 * chain supports, so this suite tests the rules and not the layout:
 *
 *   - Nothing is silently omitted. Every action the panel reasons about appears
 *     exactly once, as an offer or as a refusal with a reason. A row that simply
 *     disappears is indistinguishable, mid-incident, from a bug.
 *   - An unread flag is never treated as a read one. `null` cannot make an
 *     action look chain-derived, and cannot make it look refused because the
 *     state is supposedly benign.
 *   - The gates are the console's existing gates. When a write is disabled
 *     everywhere else, the reasons here reuse that exact sentence rather than
 *     inventing a second one that will drift.
 *   - Verification never overclaims: a failed or partial re-read is not a
 *     confirmation, and "no change" is not coloured as success.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  ACTIONS_HELD_ELSEWHERE,
  INCIDENT_ACTION_IDS,
  INCIDENT_FREEZE_ANCHOR,
  INCIDENT_UNFREEZE_ANCHOR,
  INCIDENT_VERDICT_PRESENTATION,
  compareIncidentRead,
  describeIncidentBasis,
  describeIncidentFlags,
  flagsFromStatus,
  incidentSituation,
  planIncidentActions,
  type IncidentActionId,
  type IncidentOffer,
  type IncidentPlan,
} from "../../lib/guard/incidentActions.ts";
import { WRITE_DISABLED_HINT } from "../../lib/guard/observerMode.ts";
import type { StatusFlags } from "../../lib/guard/statusTransitions.ts";
import { routeForTab, URL_TABS, type UrlTab } from "../../lib/guard/urlState.ts";

const UNREADABLE =
  "The live read a write must preflight failed, so the console will not submit blind. Retry the read; write actions re-enable as soon as it succeeds.";

/** The three flags answered by a definite read. */
function flags(
  adminFrozen: boolean | null,
  heartbeatExpired: boolean | null,
  hasPolicy: boolean | null,
): StatusFlags {
  return { adminFrozen, heartbeatExpired, hasPolicy };
}

/** Every combination of the three tri-state flags the panel can be handed. */
function allFlagStates(): StatusFlags[] {
  const values: (boolean | null)[] = [true, false, null];
  const out: StatusFlags[] = [];
  for (const adminFrozen of values) {
    for (const heartbeatExpired of values) {
      for (const hasPolicy of values) {
        out.push(flags(adminFrozen, heartbeatExpired, hasPolicy));
      }
    }
  }
  return out;
}

function plan(
  status: StatusFlags,
  overrides: { walletConnected?: boolean; preflightUnavailable?: string | null } = {},
): IncidentPlan {
  return planIncidentActions({
    status,
    walletConnected: overrides.walletConnected ?? true,
    preflightUnavailable: overrides.preflightUnavailable ?? null,
  });
}

function offerOf(result: IncidentPlan, id: IncidentActionId): IncidentOffer | undefined {
  return result.offers.find((candidate) => candidate.id === id);
}

function reasonOf(result: IncidentPlan, id: IncidentActionId): string | undefined {
  return result.refusals.find((candidate) => candidate.id === id)?.reason;
}

// ── The partition is total ──────────────────────────────────────────────────

test("every action appears exactly once, as an offer or as a reasoned refusal, on every state", () => {
  for (const status of allFlagStates()) {
    for (const walletConnected of [true, false]) {
      for (const preflightUnavailable of [null, UNREADABLE]) {
        const result = plan(status, { walletConnected, preflightUnavailable });
        const ids = [...result.offers.map((o) => o.id), ...result.refusals.map((r) => r.id)].sort();
        assert.deepEqual(
          ids,
          [...INCIDENT_ACTION_IDS].sort(),
          `partition broke on ${JSON.stringify(status)} wallet=${walletConnected} preflight=${preflightUnavailable !== null}`,
        );
        assert.equal(new Set(ids).size, ids.length, "an action cannot be both offered and refused");
      }
    }
  }
});

test("no refusal is ever an empty reason — an unexplained absence is the bug this panel replaces", () => {
  for (const status of allFlagStates()) {
    const result = plan(status);
    for (const refusal of result.refusals) {
      assert.ok(refusal.reason.trim().length > 0, `${refusal.id} refused with no reason`);
      assert.ok(refusal.label.trim().length > 0, `${refusal.id} has no label`);
    }
    for (const offer of result.offers) {
      assert.ok(offer.effect.trim().length > 0, `${offer.id} offers with no stated effect`);
      assert.ok(
        offer.confirmation.trim().length > 0,
        `${offer.id} offers with no stated confirmation`,
      );
    }
  }
});

test("the reason vocabulary is flag-specific: not-needed, not-applicable and unread are three sentences", () => {
  // Already frozen: the freeze is not needed, and the unfreeze becomes available.
  const frozen = plan(flags(true, false, true));
  assert.match(reasonOf(frozen, "freeze")!, /already admin-frozen/);
  assert.ok(offerOf(frozen, "unfreeze"), "a frozen account must be offered the way back");

  // Not frozen: the unfreeze is not needed, and the freeze is available.
  const live = plan(flags(false, false, true));
  assert.match(reasonOf(live, "unfreeze")!, /not frozen, so there is nothing to clear/);
  assert.ok(offerOf(live, "freeze"));

  // No policy: revoking is not needed, and the reason says what is true instead.
  const bare = plan(flags(false, false, false));
  assert.match(reasonOf(bare, "revoke-policy")!, /already in default deny/);
  assert.equal(offerOf(bare, "revoke-policy"), undefined);
});

test("an unread flag is refused as unread rather than guessed at in either direction", () => {
  // `adminFrozen: null` with a definite `hasPolicy` — the shape a partial read
  // would produce. The unfreeze cannot be offered (nothing says it is frozen)
  // and must not be refused as "not frozen" (nothing says that either).
  const result = plan(flags(null, false, true));
  assert.match(reasonOf(result, "unfreeze")!, /did not answer whether the account is frozen/);
  assert.doesNotMatch(reasonOf(result, "unfreeze")!, /not frozen, so there is nothing to clear/);

  const policyUnread = plan(flags(false, false, null));
  assert.match(
    reasonOf(policyUnread, "revoke-policy")!,
    /did not answer whether a policy is installed/,
  );
  assert.doesNotMatch(reasonOf(policyUnread, "revoke-policy")!, /already in default deny/);
});

test("the only unread-backed offer is the freeze, and only while no flag was answered at all", () => {
  for (const status of allFlagStates()) {
    const result = plan(status);
    for (const offer of result.offers) {
      if (offer.id === "freeze") {
        // The pre-first-read window is the sole unbacked offer, and it is
        // labelled as such rather than rendered like a chain-derived row.
        assert.equal(
          offer.unbackedByRead,
          status.adminFrozen === null,
          "freeze's backing must track the flag",
        );
      } else {
        assert.equal(
          offer.unbackedByRead,
          false,
          `${offer.id} is only offered from a definite read`,
        );
      }
    }
  }
});

// ── The gates are the console's existing gates ──────────────────────────────

test("an observer session is refused every action with the console's own connect-your-wallet sentence", () => {
  const result = plan(flags(true, true, true), { walletConnected: false });
  assert.equal(result.offers.length, 0);
  assert.deepEqual(
    result.refusals.map((r) => r.reason),
    INCIDENT_ACTION_IDS.map(() => `${WRITE_DISABLED_HINT}.`),
    "the hint is reused verbatim so the panel cannot drift from the disabled buttons",
  );
});

test("a failed live read refuses freeze too — the panel must not offer what Emergency has disabled", () => {
  // The asymmetry a reviewer will reach for: freeze is the *safe* action, so it
  // looks like it should survive an unknown state. It does not, because
  // `evaluateOffline` already disables it console-wide (issue #348) and a second
  // opinion from this panel would contradict the inert button beside it.
  const result = plan(flags(false, false, false), { preflightUnavailable: UNREADABLE });
  assert.equal(result.offers.length, 0, "no offer may survive the gate that disables every write");
  assert.equal(reasonOf(result, "freeze"), UNREADABLE);
});

test("the wallet gate is checked before the read gate, so the actionable reason wins", () => {
  const result = plan(flags(false, false, false), {
    walletConnected: false,
    preflightUnavailable: UNREADABLE,
  });
  assert.equal(reasonOf(result, "freeze"), `${WRITE_DISABLED_HINT}.`);
});

// ── The hand-off targets are real ───────────────────────────────────────────

test("every hand-off names a route the URL layer actually validates", () => {
  const plans = [plan(flags(true, false, true)), plan(flags(false, false, true))];
  const handoffs = plans.flatMap((p) => p.offers.map((o) => o.handoff));
  assert.ok(handoffs.length > 0);
  for (const handoff of handoffs) {
    const tab: UrlTab = handoff.kind === "route" ? ("configure" as UrlTab) : "panic";
    assert.ok(URL_TABS.includes(tab), `${tab} must be a known tab`);
    const route = routeForTab(tab);
    assert.ok(route, `${tab} must resolve to a route the fallback link can use`);
    assert.equal(handoff.destination.length > 0, true);
    if (handoff.kind === "route") {
      assert.equal(handoff.href, route, "the injected href must equal the validated route");
    }
  }

  for (const action of ACTIONS_HELD_ELSEWHERE) {
    if (action.href === null) continue;
    const tab = action.href.slice(1) as UrlTab;
    assert.equal(routeForTab(tab), action.href, `${action.label} links to an unrouted path`);
  }
});

test("the focus anchors exist on Emergency's own controls", () => {
  // This is the DOM contract between two panels. If PanicPanel renames or drops
  // the marker, the hand-off silently becomes a no-op row — so it is pinned here
  // against the real source rather than only against a test fixture.
  const source = readFileSync("components/PanicPanel.tsx", "utf8");
  assert.match(source, new RegExp(`data-incident-action="${INCIDENT_FREEZE_ANCHOR}"`));
  assert.match(source, new RegExp(`data-incident-action="${INCIDENT_UNFREEZE_ANCHOR}"`));
  assert.equal(INCIDENT_FREEZE_ANCHOR, "freeze");
  assert.equal(INCIDENT_UNFREEZE_ANCHOR, "unfreeze");
});

test("only freeze has a confirmation dialog; the other two say the wallet prompt is the confirmation", () => {
  const frozen = plan(flags(true, false, true));
  const live = plan(flags(false, false, true));
  const unfreeze = offerOf(frozen, "unfreeze")!;
  const revoke = offerOf(frozen, "revoke-policy")!;
  const freeze = offerOf(live, "freeze")!;

  assert.match(freeze.confirmation, /acknowledgement/);
  assert.doesNotMatch(unfreeze.confirmation, /acknowledgement|dialog/);
  assert.match(unfreeze.confirmation, /submits on the click/);
  assert.match(revoke.confirmation, /submits on the click/);
  assert.notEqual(
    unfreeze.confirmation,
    revoke.confirmation,
    "each names the screen it submits from",
  );
});

test("the panel never claims to sign: the three actions carry distinct effects and one destination each", () => {
  const effects = INCIDENT_ACTION_IDS.map((id) => {
    const source = plan(id === "unfreeze" ? flags(true, false, true) : flags(false, false, true));
    const offer = offerOf(source, id) ?? source.refusals.find((r) => r.id === id)!;
    return offer.label;
  });
  assert.equal(new Set(effects).size, effects.length);

  const live = plan(flags(false, false, true));
  const frozen = plan(flags(true, false, true));
  assert.equal(offerOf(live, "freeze")!.handoff.kind, "focus");
  assert.equal(offerOf(live, "freeze")!.handoff.destination, "Emergency");
  assert.equal(offerOf(frozen, "unfreeze")!.handoff.destination, "Emergency");
  assert.equal(offerOf(live, "revoke-policy")!.handoff.destination, "Configure");
});

test("the exclusions name where the action lives, and the one the dashboard cannot do has no invented link", () => {
  const labels = ACTIONS_HELD_ELSEWHERE.map((a) => a.label);
  assert.deepEqual(labels, [
    "Install or adjust a policy",
    "Rotate the agent key",
    "Send a heartbeat",
  ]);
  const heartbeat = ACTIONS_HELD_ELSEWHERE.find((a) => a.label === "Send a heartbeat")!;
  assert.equal(
    heartbeat.href,
    null,
    "a heartbeat is the agent's write; pointing at a screen would be a lie",
  );
  assert.match(heartbeat.where, /agent process/);
});

// ── What the plan was decided from ──────────────────────────────────────────

test("the situation states observed flags and never a diagnosis", () => {
  assert.match(incidentSituation(flags(null, null, null)), /No live status read yet/);
  assert.match(incidentSituation(flags(true, true, false)), /admin-frozen/);
  assert.match(incidentSituation(flags(true, true, false)), /dead-man switch has fired/);
  assert.match(incidentSituation(flags(true, true, false)), /no policy is installed/);
  assert.match(incidentSituation(flags(false, false, true)), /not admin-frozen/);
  // A healthy account is not described as frozen, and an unread freeze is not
  // folded into "not frozen".
  assert.doesNotMatch(incidentSituation(flags(false, false, true)), /is admin-frozen/);
  assert.match(incidentSituation(flags(null, false, true)), /admin freeze is unread/);
});

test("the basis names the instant of the read behind the list, not the page load", () => {
  const readAt = "2026-11-23T10:00:00.000Z";
  const nowMs = Date.parse(readAt) + 240_000;
  const read = describeIncidentBasis({ readAt, error: null, nowMs });
  assert.equal(read.kind, "read");
  assert.equal(read.readAt, readAt);
  assert.match(read.words, /^Decided from a status read 4m ago\.$/);

  // The shared phrase helper must not bolt a second "ago" onto its own sentinel.
  const fresh = describeIncidentBasis({ readAt, error: null, nowMs: Date.parse(readAt) + 500 });
  assert.match(fresh.words, /^Decided from a status read just now\.$/);
  assert.doesNotMatch(fresh.words, /just now ago/, "the phrase must not be doubled");

  // A failed read wins over a stale stamp: the panel must not quote the last
  // successful instant as though the plan still rested on it.
  const failed = describeIncidentBasis({ readAt, error: "rpc: connection reset", nowMs });
  assert.equal(failed.kind, "failed");
  assert.equal(failed.readAt, null);
  assert.equal(failed.error, "rpc: connection reset");
  assert.match(failed.words, /were not decided from chain state/);

  const never = describeIncidentBasis({ readAt: null, error: null, nowMs });
  assert.equal(never.kind, "never");
  assert.match(never.words, /nothing here is backed by chain state/);
});

// ── Verification never overclaims ───────────────────────────────────────────

test("a re-read counts as changed only when both reads answered the flag", () => {
  const same = flags(false, false, true);

  assert.equal(compareIncidentRead(same, same).verdict, "unchanged");

  const moved = compareIncidentRead(flags(false, false, true), flags(true, false, true));
  assert.equal(moved.verdict, "changed");
  assert.deepEqual(moved.changed, ["admin freeze set"]);

  // Out of unknown into definite is a read that started answering, not a chain
  // that changed — the same discipline `transitionsBetween` applies.
  const discovered = compareIncidentRead(flags(null, null, null), same);
  assert.equal(discovered.verdict, "incomplete");
  assert.deepEqual(discovered.changed, []);
  assert.equal(discovered.uncomparable.length, 3);

  const lost = compareIncidentRead(same, flags(null, false, true));
  assert.equal(lost.verdict, "incomplete");
  assert.deepEqual(lost.changed, []);
  assert.match(lost.words, /That is not a confirmation/);
});

test("a failed verification read is its own verdict and says nothing was confirmed", () => {
  const unread = compareIncidentRead(flags(true, false, true), flags(null, null, null));
  assert.equal(unread.verdict, "unread");
  assert.match(unread.words, /nothing has been confirmed either way/);
  assert.deepEqual(unread.changed, []);
});

test("no verdict that means 'we do not know' is presented as reassurance", () => {
  const tones = INCIDENT_VERDICT_PRESENTATION;
  assert.equal(tones.unread.tone, "danger");
  assert.equal(tones.incomplete.tone, "warn");
  // `unchanged` is the subtle one: the panel cannot know which write the
  // operator meant, so agreement is a fact rather than a success.
  assert.equal(tones.unchanged.tone, "muted");
  assert.equal(tones.changed.tone, "warn");
  for (const verdict of Object.keys(tones) as (keyof typeof tones)[]) {
    assert.notEqual(tones[verdict].tone, "ok", `${verdict} must never read as confirmation`);
    assert.ok(tones[verdict].words.length > 0);
  }
});

test("the flag rows spell out an unread flag instead of the word a missing value would take", () => {
  const rows = describeIncidentFlags(flags(null, false, null));
  assert.deepEqual(
    rows.map((r) => r.label),
    ["admin freeze", "dead-man switch", "installed policy"],
  );
  assert.deepEqual(
    rows.map((r) => [r.words, r.unread]),
    [
      ["not read", true],
      ["within grace", false],
      ["not read", true],
    ],
  );
  // The truthy vocabularies are per flag: "set" for a freeze, "expired" for the
  // dead-man switch, "installed" for a policy.
  assert.deepEqual(
    describeIncidentFlags(flags(true, true, true)).map((r) => r.words),
    ["set", "expired", "installed"],
  );
});

test("flagsFromStatus makes a failed read all-null rather than all-false", () => {
  assert.deepEqual(flagsFromStatus(null), flags(null, null, null));
  assert.deepEqual(
    flagsFromStatus({ adminFrozen: false, heartbeatExpired: true, hasPolicy: false }),
    flags(false, true, false),
  );
});

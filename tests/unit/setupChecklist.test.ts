import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GuardStatus, PolicyConfig } from "stellar-agent-guard-sdk";
import type { ReadResult } from "../../lib/guard/chain.ts";
import {
  SETUP_STORAGE_KEY,
  SETUP_STORED_KEYS,
  defaultDenyWarning,
  deriveSetupSteps,
  dismissSetupWizard,
  readSetupState,
  rememberDeployment,
  restoreSetupWizard,
  writeSetupState,
  type SetupStorage,
} from "../../lib/guard/setupChecklist.ts";

const GUARD = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

function status(hasPolicy: boolean): GuardStatus {
  return {
    has_policy: hasPolicy,
    admin_frozen: false,
    heartbeat_expired: false,
    last_heartbeat: 1_700_000_000n,
    now: 1_700_000_100n,
  };
}

const POLICY = { per_tx_cap: 100n } as unknown as PolicyConfig;

const ok = <T>(value: T): ReadResult<T> => ({ ok: true, value });
const fail = <T>(error: string): ReadResult<T> => ({ ok: false, error });

/** The derived step for an id, or a test failure if it is missing. */
function stepOf(
  inputs: Parameters<typeof deriveSetupSteps>[0],
  id: "deployed" | "initialized" | "policy" | "verified",
) {
  const step = deriveSetupSteps(inputs).find((candidate) => candidate.id === id);
  assert.ok(step, `expected a ${id} step`);
  return step;
}

/** A minimal in-memory `Storage`, so the audit can read the raw JSON. */
function memoryStorage() {
  const map = new Map<string, string>();
  const storage: SetupStorage = {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
  return { storage, raw: () => map.get(SETUP_STORAGE_KEY) ?? null };
}

function base(overrides: Partial<Parameters<typeof deriveSetupSteps>[0]> = {}) {
  return {
    deployedMarker: null,
    initialized: ok(true),
    status: ok(status(true)),
    policy: ok(POLICY),
    verified: null,
    ...overrides,
  };
}

describe("setup step derivation is a function of live reads (issue #24)", () => {
  it("fresh deploy (marker only): step 1 done, the rest pending", () => {
    const inputs = base({
      deployedMarker: GUARD,
      initialized: ok(false),
      status: ok(status(false)),
      policy: ok(null),
    });
    const steps = deriveSetupSteps(inputs);
    assert.deepEqual(
      steps.map((step) => step.state),
      ["done", "pending", "pending", "pending"],
    );
  });

  it("initialized without a policy: steps 1–2 done, 3 pending, 4 pending reads-verify", () => {
    const steps = deriveSetupSteps(
      base({ deployedMarker: GUARD, status: ok(status(false)), policy: ok(null) }),
    );
    assert.deepEqual(
      steps.map((step) => step.state),
      ["done", "done", "pending", "pending"],
    );
    assert.match(steps[2]!.detail, /default-deny/);
  });

  it("policy set: step 3 done, step 4 still pending until a live re-read confirms", () => {
    const steps = deriveSetupSteps(base({ deployedMarker: GUARD }));
    assert.deepEqual(
      steps.map((step) => step.state),
      ["done", "done", "done", "pending"],
    );
    assert.match(steps[3]!.detail, /Re-verify/);
  });

  it("all four done only once the verify re-read confirms a policy", () => {
    const steps = deriveSetupSteps(
      base({ deployedMarker: GUARD, verified: ok({ hasPolicy: true }) }),
    );
    assert.deepEqual(
      steps.map((step) => step.state),
      ["done", "done", "done", "done"],
    );
  });

  it("derives from truth rather than any stored completion bit", () => {
    const before = deriveSetupSteps(
      base({ deployedMarker: GUARD, status: ok(status(false)), policy: ok(null) }),
    );
    const after = deriveSetupSteps(
      base({ deployedMarker: GUARD, status: ok(status(true)), policy: ok(POLICY) }),
    );
    assert.equal(before[2]!.state, "pending");
    assert.equal(after[2]!.state, "done", "a chain change alone flips the step — no local write");
  });
});

describe("read failures never look like success (issue #24)", () => {
  it("an unreadable initialize state is an error, not a silent pending", () => {
    const step = stepOf(base({ initialized: fail("rpc down") }), "initialized");
    assert.equal(step.state, "error");
    assert.match(step.detail, /rpc down/);
  });

  it("the policy step is an error when either status() or policy() is unreadable", () => {
    const step = stepOf(
      base({ status: fail("status unavailable"), policy: fail("policy unavailable") }),
      "policy",
    );
    assert.equal(step.state, "error");
    assert.equal(stepOf(base({ status: fail("x"), policy: ok(POLICY) }), "policy").state, "error");
    assert.equal(
      stepOf(base({ status: ok(status(true)), policy: fail("x") }), "policy").state,
      "error",
    );
  });

  it("does not mark policy done when status() failed, even if policy() answered", () => {
    const step = stepOf(base({ status: fail("status unavailable"), policy: ok(POLICY) }), "policy");
    assert.equal(step.state, "error");
    assert.match(step.detail, /status unavailable/);
  });

  it("reports inconsistent successful policy reads as an error", () => {
    const step = stepOf(base({ status: ok(status(true)), policy: ok(null) }), "policy");
    assert.equal(step.state, "error");
    assert.match(step.detail, /inconsistent/);
  });

  it("a failed verification re-read stays an error/pending, never optimistically green", () => {
    const step = stepOf(base({ verified: fail("fetch failed") }), "verified");
    assert.equal(step.state, "error");
    assert.match(step.detail, /retry/i);
    // A confirmed read that reports *no* policy is still pending, not done.
    assert.equal(stepOf(base({ verified: ok({ hasPolicy: false }) }), "verified").state, "pending");
  });
});

describe("default-deny warning is derived from status() alone (issue #24)", () => {
  it("is on when the chain answered and reported no policy", () => {
    assert.equal(defaultDenyWarning(ok(status(false))), true);
  });

  it("is off when a policy is installed", () => {
    assert.equal(defaultDenyWarning(ok(status(true))), false);
  });

  it("never claims safety from a failed read, and never claims danger either", () => {
    // A failed read is rendered as its own error block; it is not health and not
    // proof of a missing policy.
    assert.equal(defaultDenyWarning(fail("unreachable")), false);
  });
});

describe("stored wizard state holds exactly two keys (issue #24 audit)", () => {
  it("persists only the allowed keys", () => {
    const { storage, raw } = memoryStorage();
    rememberDeployment(GUARD, storage);
    dismissSetupWizard(GUARD, storage);
    const envelope = JSON.parse(raw() ?? "{}") as Record<string, Record<string, unknown>>;
    const entry = envelope[GUARD]!;
    assert.deepEqual([...Object.keys(entry)].sort(), [...SETUP_STORED_KEYS].sort());
    assert.deepEqual(entry, { dismissed: true, deployedMarker: GUARD });
  });

  it("strips unknown keys from an entry that already has them", () => {
    const { storage } = memoryStorage();
    storage.setItem(
      SETUP_STORAGE_KEY,
      JSON.stringify({
        [GUARD]: { dismissed: true, deployedMarker: null, completedSteps: ["policy"] },
      }),
    );
    const stored = readSetupState(GUARD, storage);
    assert.deepEqual(stored, { dismissed: true, deployedMarker: null });
    assert.equal(Object.keys(stored).length, 2);
  });

  it("round-trips dismiss and restore without adding keys", () => {
    const { storage, raw } = memoryStorage();
    assert.equal(readSetupState(GUARD, storage).dismissed, false);

    dismissSetupWizard(GUARD, storage);
    assert.equal(readSetupState(GUARD, storage).dismissed, true);

    // A second write must not introduce any new key.
    writeSetupState(GUARD, { deployedMarker: GUARD }, storage);
    restoreSetupWizard(GUARD, storage);
    const entry = (JSON.parse(raw() ?? "{}") as Record<string, Record<string, unknown>>)[GUARD]!;
    assert.deepEqual([...Object.keys(entry)].sort(), [...SETUP_STORED_KEYS].sort());
    assert.deepEqual(readSetupState(GUARD, storage), { dismissed: false, deployedMarker: GUARD });
  });

  it("degrades to defaults on corrupt or missing storage rather than throwing", () => {
    const { storage } = memoryStorage();
    storage.setItem(SETUP_STORAGE_KEY, "{not json");
    assert.deepEqual(readSetupState(GUARD, storage), { dismissed: false, deployedMarker: null });
    assert.deepEqual(readSetupState(GUARD, null), { dismissed: false, deployedMarker: null });
  });

  it("keeps state per guard", () => {
    const other = "CDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";
    const { storage } = memoryStorage();
    dismissSetupWizard(GUARD, storage);
    assert.equal(readSetupState(GUARD, storage).dismissed, true);
    assert.equal(readSetupState(other, storage).dismissed, false);
  });
});

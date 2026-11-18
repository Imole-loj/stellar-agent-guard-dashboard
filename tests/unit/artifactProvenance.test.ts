/**
 * Bytecode verification provenance (issue #290): what the panel says about the
 * artifact check, and when that check may authorize a deploy.
 *
 * The distinction these tests pin is the whole point of the feature — a cached
 * verification is labelled as one, carries the time of the read it reuses, and
 * never becomes a substitute for the ledger read (which `verifyWasmIdentity`
 * always performs live; see `tests/unit/chain.test.ts` for that half).
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  artifactGate,
  artifactProvenance,
  formatVerifiedAt,
  type ArtifactGateInput,
} from "../../lib/guard/artifactProvenance.ts";
import { PHASE1_ARTIFACT } from "../../lib/guard/network.ts";
import type { ArtifactCheck } from "../../lib/guard/guardOps.ts";

const VERIFIED_AT = "2026-10-20T10:11:12.000Z";

function check(overrides: Partial<ArtifactCheck> = {}, live: Partial<ArtifactCheck["live"]> = {}) {
  return {
    pinnedHash: PHASE1_ARTIFACT.wasmHash,
    pinnedBytes: PHASE1_ARTIFACT.wasmBytes,
    live: {
      reportedWasmHash: PHASE1_ARTIFACT.wasmHash,
      fetchedSha256: PHASE1_ARTIFACT.wasmHash,
      bytes: PHASE1_ARTIFACT.wasmBytes,
      match: true,
      source: "network" as const,
      verifiedAt: VERIFIED_AT,
      ...live,
    },
    ok: true,
    detail: "matches",
    ...overrides,
  } satisfies ArtifactCheck;
}

describe("artifactProvenance", () => {
  test("a network read states the instance, hash prefix, byte length and read time", () => {
    const provenance = artifactProvenance(check());

    assert.equal(provenance.sourceInstance, PHASE1_ARTIFACT.guard);
    assert.equal(provenance.byteSource, "network");
    assert.equal(provenance.byteSourceLabel, "network read");
    assert.equal(provenance.hashPrefix, PHASE1_ARTIFACT.wasmHash.slice(0, 16));
    assert.equal(provenance.bytes, PHASE1_ARTIFACT.wasmBytes);
    assert.equal(provenance.verifiedAt, VERIFIED_AT);
    assert.equal(provenance.verifiedLabel, "2026-10-20 10:11:12 UTC");
  });

  test("a cache hit is labelled as one and keeps the time of the read it reuses", () => {
    const older = "2026-10-20T08:00:00.000Z";
    const provenance = artifactProvenance(check({}, { source: "cache", verifiedAt: older }));

    assert.equal(provenance.byteSource, "cache");
    assert.equal(provenance.byteSourceLabel, "cache hit");
    // Not "now": a hit reports when the bytes were actually read and hashed.
    assert.equal(provenance.verifiedAt, older);
    assert.equal(provenance.verifiedLabel, "2026-10-20 08:00:00 UTC");
  });

  test("the timestamp is rendered in UTC so it reads the same everywhere", () => {
    assert.equal(formatVerifiedAt(VERIFIED_AT), "2026-10-20 10:11:12 UTC");
    assert.equal(formatVerifiedAt("not a timestamp"), "verification time unavailable");
  });
});

describe("artifactGate", () => {
  const gate = (input: Partial<ArtifactGateInput>) =>
    artifactGate({ check: check(), error: null, refreshing: false, ...input });

  test("a passing pin and length check enables deploy", () => {
    assert.deepEqual(gate({}), { disabled: false, reason: null });
  });

  test("a verification in flight disables deploy until the new answer is in", () => {
    const state = gate({ refreshing: true });
    assert.equal(state.disabled, true);
    assert.match(state.reason ?? "", /re-verified/i);
  });

  test("a mismatched artifact disables deploy and says which checks fail", () => {
    const mismatch = gate({
      check: check(
        { ok: false, detail: "the artifact on chain does not match" },
        { fetchedSha256: "deadbeef", match: false },
      ),
    });
    assert.equal(mismatch.disabled, true);
    assert.match(mismatch.reason ?? "", /pinned hash and byte length/);
  });

  test("an RPC failure disables deploy: uncertainty is never a pass", () => {
    const failed = gate({ check: null, error: "HTTP 429 from the RPC" });
    assert.equal(failed.disabled, true);
    assert.match(failed.reason ?? "", /could not be read/);
    assert.match(failed.reason ?? "", /429/);
  });

  test("no check at all disables deploy", () => {
    const waiting = gate({ check: null });
    assert.equal(waiting.disabled, true);
    assert.match(waiting.reason ?? "", /not been checked/);
  });

  test("a cache hit that the live ledger still confirms may authorize deploy — labelled as a hit", () => {
    // The cached entry only ever stands in for the (immutable) bytecode fetch:
    // `verifyWasmIdentity` re-reads the ledger's declared hash before answering,
    // so a hit whose hash no longer matches the instance never reaches here.
    const cached = gate({ check: check({}, { source: "cache" }) });
    assert.deepEqual(cached, { disabled: false, reason: null });
    assert.equal(artifactProvenance(check({}, { source: "cache" })).byteSourceLabel, "cache hit");
  });
});

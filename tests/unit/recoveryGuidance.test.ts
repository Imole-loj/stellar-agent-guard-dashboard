import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RECOVERY_RULES,
  classifyFailure,
  type FailureCategory,
} from "../../lib/guard/recoveryGuidance.ts";

/**
 * One realistic message per mapped category. The table is the contract: a new
 * category without a sample fails the completeness assertion at the bottom.
 */
const SAMPLES: Array<[Exclude<FailureCategory, "unknown">, string]> = [
  ["wallet_rejected", "User rejected the signing request in Freighter"],
  ["wallet_unavailable", "Freighter wallet is not connected"],
  [
    "network_mismatch",
    "Network mismatch: the wallet is on public while the dashboard reads testnet",
  ],
  ["account_unfunded", "could not load account GA... from the network (is the account funded?)"],
  ["simulation_refused", "simulation failed: the contract call could not be recorded"],
  ["guard_refused", "pre-flight refused: admin_frozen is set"],
  ["auth_mismatch", "Unauthorized function call for address GA..."],
  ["transaction_expired", "Transaction expired during wallet signature delay. Please retry."],
  ["sequence_mismatch", "the network rejected the transaction: tx_bad_seq"],
  ["insufficient_fee", "submission failed: tx_insufficient_fee"],
  ["network_unavailable", "RPC TIMEOUT while polling"],
  ["submission_rejected", "the network refused the transaction: unknown arm"],
  ["on_chain_failed", "transaction abc was included and rejected by the network"],
];

test("every mapped category is recognised, linked and preserves the original summary", () => {
  for (const [category, message] of SAMPLES) {
    const guidance = classifyFailure({ message, context: "write" });
    assert.equal(guidance.category, category, `${message} should map to ${category}`);
    assert.equal(guidance.recognized, true);
    assert.equal(guidance.summary, message, "the original error is never rewritten");
    assert.ok(guidance.link, `${category} should carry a runbook link`);
    assert.match(guidance.link!.href, /^https:\/\/github\.com\/.+\/docs\//);
    assert.ok(guidance.explanation.length > 20);
    assert.ok(guidance.retryLabel.length > 20);
  }
});

test("every rule category has a sample, so a new rule cannot go untested", () => {
  const covered = new Set(SAMPLES.map(([category]) => category));
  for (const rule of RECOVERY_RULES) {
    assert.ok(covered.has(rule.category), `missing sample for ${rule.category}`);
  }
});

test("an unknown failure gets no misleading runbook and no retry instruction", () => {
  const guidance = classifyFailure({ message: "Something odd happened in the widget" });
  assert.equal(guidance.category, "unknown");
  assert.equal(guidance.recognized, false);
  assert.equal(guidance.link, null);
  assert.equal(guidance.retry, "undetermined");
  assert.equal(guidance.summary, "Something odd happened in the widget");
  assert.match(guidance.explanation, /does not recognise/);
  assert.doesNotMatch(guidance.retryLabel, /safe to retry/i);
});

test("a network failure is a safe read retry but an ambiguous write", () => {
  const read = classifyFailure({ message: "RPC TIMEOUT while reading status()", context: "read" });
  assert.equal(read.category, "network_unavailable");
  assert.equal(read.retry, "read-safe");
  assert.match(read.retryLabel, /read and it did not change on-chain state/);

  const write = classifyFailure({ message: "RPC TIMEOUT after sendTransaction", context: "write" });
  assert.equal(write.retry, "write-ambiguous");
  assert.match(write.retryLabel, /may have reached the network/);
  assert.match(write.retryLabel, /Verify the transaction hash/);
});

test("the failure stage only fills in an otherwise unknown category", () => {
  const discovery = classifyFailure({ message: "opaque host rejection", stage: "discovery" });
  assert.equal(discovery.category, "simulation_refused");
  assert.equal(discovery.retry, "write-safe");

  const enforcement = classifyFailure({ message: "opaque host rejection", stage: "enforcement" });
  assert.equal(enforcement.category, "guard_refused");

  const submission = classifyFailure({ message: "opaque send failure", stage: "submission" });
  assert.equal(submission.category, "submission_rejected");

  // A recognised message keeps its category; the stage cannot make a declined
  // signature look like a guard refusal.
  const recognised = classifyFailure({
    message: "User rejected the signing request",
    stage: "enforcement",
  });
  assert.equal(recognised.category, "wallet_rejected");
});

test("a pre-broadcast refusal is never described as an ambiguous write", () => {
  for (const [category, message] of SAMPLES) {
    const guidance = classifyFailure({ message });
    if (category === "on_chain_failed" || category === "guard_refused") {
      assert.equal(guidance.retry, "none", `${category} must not invite a resend`);
    } else if (category !== "network_unavailable") {
      assert.notEqual(guidance.retry, "write-ambiguous", `${category} did not broadcast`);
    }
  }
});

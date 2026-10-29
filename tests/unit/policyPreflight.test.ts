/**
 * The `validate_policy` preflight (issue #259): decoding the contract's
 * `ValidationOutcome`, mapping every SPEC §8.1 `PolicyRuleId` to its
 * field-targeted copy, and the two outcomes the policy editor can act on.
 *
 * The wire cases are built as `ScVal`s rather than through a helper so the test
 * pins the exact shape an enum carries over the boundary: a `Vec` whose first
 * element names the variant, with `Invalid` carrying the rule (SEP-0048).
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { xdr } from "@stellar/stellar-sdk";
import {
  POLICY_RULE_GUIDANCE,
  POLICY_RULE_IDS,
  decodeValidationOutcome,
  describePolicyRule,
  preflightDecision,
} from "../../lib/guard/policyPreflight.ts";

const symbol = (name: string) => xdr.ScVal.scvSymbol(name);

/** `ValidationOutcome::Valid` */
const VALID = xdr.ScVal.scvVec([symbol("Valid")]);

/** `ValidationOutcome::Invalid(rule)` — rule is itself a unit-only enum. */
const invalid = (rule: string) =>
  xdr.ScVal.scvVec([symbol("Invalid"), xdr.ScVal.scvVec([symbol(rule)])]);

describe("decodeValidationOutcome", () => {
  test("decodes Valid", () => {
    assert.deepEqual(decodeValidationOutcome(VALID), { kind: "valid" });
  });

  test("decodes every Invalid(rule) variant, nested and inlined", () => {
    for (const rule of POLICY_RULE_IDS) {
      assert.deepEqual(decodeValidationOutcome(invalid(rule)), { kind: "invalid", rule }, rule);
      // The same enum may arrive with the payload unwrapped by a stringly-typed
      // surface; the rule id is what matters, not the wrapping.
      const inlined = xdr.ScVal.scvVec([symbol("Invalid"), symbol(rule)]);
      assert.deepEqual(
        decodeValidationOutcome(inlined),
        { kind: "invalid", rule },
        `${rule} inline`,
      );
    }
  });

  test("a bare unit-variant symbol still decodes as Valid", () => {
    assert.deepEqual(decodeValidationOutcome(symbol("Valid")), { kind: "valid" });
  });

  test("anything else throws rather than reading as a verdict", () => {
    const garbage = [
      xdr.ScVal.scvBool(true),
      xdr.ScVal.scvVoid(),
      xdr.ScVal.scvVec([]),
      xdr.ScVal.scvVec([symbol("Invalid")]),
      xdr.ScVal.scvVec([symbol("Valid"), symbol("AmountSign")]),
      xdr.ScVal.scvVec([symbol("SomethingElse")]),
      xdr.ScVal.scvU32(7),
    ];
    for (const value of garbage) {
      assert.throws(
        () => decodeValidationOutcome(value),
        /unexpected|without a rule id/,
        value.type,
      );
    }
  });

  test("Invalid carrying a non-rule payload throws instead of guessing", () => {
    const nonsense = xdr.ScVal.scvVec([symbol("Invalid"), xdr.ScVal.scvU32(3)]);
    assert.throws(() => decodeValidationOutcome(nonsense), /without a rule id/);
  });
});

describe("POLICY_RULE_GUIDANCE", () => {
  test("covers every rule id with a field and a message", () => {
    for (const rule of POLICY_RULE_IDS) {
      const guidance = POLICY_RULE_GUIDANCE[rule];
      assert.ok(guidance, `no guidance for ${rule}`);
      assert.ok(guidance.field.length > 0, `${rule} has no field`);
      assert.ok(guidance.message.length > 0, `${rule} has no message`);
    }
    assert.equal(
      Object.keys(POLICY_RULE_GUIDANCE).length,
      POLICY_RULE_IDS.length,
      "the guidance table and the rule list must not drift apart",
    );
  });

  test("carries the wording the issue specifies for its examples", () => {
    assert.match(
      POLICY_RULE_GUIDANCE.WindowRequiresWidth.message,
      /non-zero window width/,
      "a spend cap requires a non-zero window width",
    );
    assert.match(
      POLICY_RULE_GUIDANCE.SelfAddressInList.message,
      /own address cannot appear in an allowlist/,
      "the guard's own address cannot appear in an allowlist",
    );
  });

  test("an unknown rule id still renders, naming the id it came with", () => {
    const guidance = describePolicyRule("SomeFutureRule");
    assert.ok(guidance.field.length > 0);
    assert.match(guidance.message, /SomeFutureRule/);
  });
});

describe("preflightDecision", () => {
  test("a failed read has no verdict and never blocks", () => {
    // The read is additive: an older contract without `validate_policy` or an
    // RPC failure must leave the write path exactly as it was (issue #259).
    assert.deepEqual(preflightDecision({ ok: false, error: "HostError: Error(Contract, #4)" }), {
      kind: "allow",
    });
  });

  test("Valid allows submission", () => {
    assert.deepEqual(preflightDecision({ ok: true, value: { kind: "valid" } }), {
      kind: "allow",
    });
  });

  test("Invalid blocks with the rule's field-targeted copy", () => {
    const decision = preflightDecision({
      ok: true,
      value: { kind: "invalid", rule: "WindowRequiresWidth" },
    });
    assert.equal(decision.kind, "block");
    if (decision.kind !== "block") return;
    assert.equal(decision.rule, "WindowRequiresWidth");
    assert.equal(decision.field, POLICY_RULE_GUIDANCE.WindowRequiresWidth.field);
    assert.equal(decision.message, POLICY_RULE_GUIDANCE.WindowRequiresWidth.message);
  });

  test("an unknown rule still blocks, rather than slipping through as valid", () => {
    const decision = preflightDecision({ ok: true, value: { kind: "invalid", rule: "NewRule" } });
    assert.equal(decision.kind, "block");
    if (decision.kind !== "block") return;
    assert.match(decision.message, /NewRule/);
  });
});

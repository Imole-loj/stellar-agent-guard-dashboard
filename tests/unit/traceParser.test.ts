import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Address, xdr } from "@stellar/stellar-sdk";
import { explainReason } from "stellar-agent-guard-sdk";
import { parseDiagnosticLogs } from "../../lib/guard/traceParser.ts";
import { MOCK_GUARD, diagnosticEventXdr } from "../mocks/sorobanFixtures.ts";

const sym = (name: string): xdr.ScVal => xdr.ScVal.scvSymbol(name);

/** A `fn_call` diagnostic event, exactly as the host emits it. */
function fnCall(contractId: string, functionName: string, args: xdr.ScVal[] = []): string {
  return diagnosticEventXdr({
    contractId,
    topics: [sym("fn_call"), new Address(contractId).toScVal(), sym(functionName)],
    value: xdr.ScVal.scvVec(args),
  });
}

/** A `fn_return` diagnostic event. */
function fnReturn(value: xdr.ScVal = xdr.ScVal.scvVoid()): string {
  return diagnosticEventXdr({ contractId: MOCK_GUARD, topics: [sym("fn_return")], value });
}

/** An `error` diagnostic event carrying a contract error code. */
function errorEvent(code: number): string {
  return diagnosticEventXdr({
    contractId: MOCK_GUARD,
    topics: [sym("error"), xdr.ScVal.scvError(xdr.ScError.sceContract(code))],
    value: xdr.ScVal.scvString("escalating error to VM trap from failed host function call: call"),
  });
}

/**
 * Code 22 is `per_tx_cap_exceeded` in the contract's `Error` enum, which the SDK
 * vendors as `GUARD_REASON_CODES`. A code the SDK does not define (999) is the
 * other half of every fixture here: the console must quote it back and say it is
 * not recognized, because contract vocabularies outrun a pinned build.
 */
const KNOWN_CODE = 22;
const UNKNOWN_CODE = 999;

describe("traceParser", () => {
  test("returns no tree for an empty event list", () => {
    assert.deepEqual(parseDiagnosticLogs([]), { tree: [] });
  });

  test("decodes a guard refusal from a plain host error string", () => {
    const result = parseDiagnosticLogs([`Error(Contract, #${KNOWN_CODE})`]);
    assert.match(result.tree[0]?.error ?? "", /per_tx_cap_exceeded/);
    assert.equal(result.tree[0]?.errorExplanation?.recognized, true);
    assert.equal(result.tree[0]?.errorExplanation?.raw, KNOWN_CODE);
  });

  test("a code the SDK does not define is quoted, not renamed", () => {
    // `#100` was once rendered as a made-up `SpendCapExceeded`. The contract has
    // no such code, and a confident wrong name sends an operator to fix the
    // wrong thing — so the honest answer is "not recognized" plus the number.
    const result = parseDiagnosticLogs(["Error(Contract, #100)"]);
    const explanation = result.tree[0]?.errorExplanation;
    assert.equal(explanation?.recognized, false);
    assert.equal(explanation?.reason, null);
    assert.equal(explanation?.raw, 100);
    assert.match(result.tree[0]?.error ?? "", /100/);
    assert.doesNotMatch(result.tree[0]?.error ?? "", /SpendCapExceeded/);
  });

  test("decodes a diagnostic object with a numeric guard error", () => {
    const result = parseDiagnosticLogs([
      {
        type: "diagnostic",
        contractId: "C123",
        functionName: "set_policy",
        args: [],
        error: KNOWN_CODE,
      },
    ]);
    assert.match(result.tree[0]?.error ?? "", /per_tx_cap_exceeded/);
    assert.equal(result.tree[0]?.functionName, "set_policy");
  });

  test("builds a flat call frame from real fn_call/fn_return XDR", () => {
    const tree = parseDiagnosticLogs([fnCall(MOCK_GUARD, "set_policy"), fnReturn()]).tree;

    assert.equal(tree.length, 1);
    assert.equal(tree[0]?.contractId, MOCK_GUARD);
    assert.equal(tree[0]?.functionName, "set_policy");
    assert.equal(tree[0]?.subCalls.length, 0);
    assert.match(tree[0]?.events[0] ?? "", /return:/);
  });

  test("keeps invocation arguments in the frame", () => {
    const tree = parseDiagnosticLogs([
      fnCall(MOCK_GUARD, "transfer", [xdr.ScVal.scvU32(7)]),
      fnReturn(),
    ]).tree;

    assert.deepEqual(tree[0]?.arguments, [7]);
  });

  test("nests deeply nested sub-invocations into call hierarchy trees", () => {
    const tree = parseDiagnosticLogs([
      fnCall(MOCK_GUARD, "set_policy"),
      fnCall(MOCK_GUARD, "check_auth"),
      fnCall(MOCK_GUARD, "record_spend"),
      errorEvent(KNOWN_CODE),
      fnReturn(),
      fnReturn(),
      fnReturn(),
    ]).tree;

    assert.equal(tree.length, 1, "only the outermost frame is a root");
    const outer = tree[0];
    assert.equal(outer?.functionName, "set_policy");
    const middle = outer?.subCalls[0];
    assert.equal(middle?.functionName, "check_auth");
    const inner = middle?.subCalls[0];
    assert.equal(inner?.functionName, "record_spend");
    assert.match(inner?.error ?? "", /per_tx_cap_exceeded/, "the error lands on the deepest frame");
    assert.equal(outer?.error, undefined, "the outer frames stay clean");
    assert.equal(inner?.subCalls.length, 0);
  });

  test("a sibling call after a nested one is attached to the parent, not the child", () => {
    const tree = parseDiagnosticLogs([
      fnCall(MOCK_GUARD, "set_policy"),
      fnCall(MOCK_GUARD, "read_window"),
      fnReturn(),
      fnCall(MOCK_GUARD, "write_policy"),
      fnReturn(),
      fnReturn(),
    ]).tree;

    const outer = tree[0];
    assert.equal(outer?.subCalls.length, 2);
    assert.equal(outer?.subCalls[0]?.functionName, "read_window");
    assert.equal(outer?.subCalls[1]?.functionName, "write_policy");
  });

  test("decodes every common guard error code and keeps unknown ones verbatim", () => {
    const known = parseDiagnosticLogs([errorEvent(KNOWN_CODE)]).tree[0];
    assert.equal(known?.errorExplanation?.reason, "per_tx_cap_exceeded");
    assert.equal(known?.errorExplanation?.recognized, true);
    assert.ok(
      (known?.error ?? "").includes(explainReason(KNOWN_CODE)),
      "the operator line carries the SDK's own explanation, verbatim",
    );

    const unknown = parseDiagnosticLogs([errorEvent(UNKNOWN_CODE)]).tree[0];
    assert.equal(unknown?.errorExplanation?.reason, null);
    assert.equal(unknown?.errorExplanation?.recognized, false);
    assert.equal(unknown?.errorExplanation?.raw, UNKNOWN_CODE);
    assert.match(unknown?.error ?? "", /999/);
  });

  test("decodes an auth failure from a diagnostic event", () => {
    const tree = parseDiagnosticLogs([
      diagnosticEventXdr({
        contractId: MOCK_GUARD,
        topics: [
          sym("error"),
          xdr.ScVal.scvError(xdr.ScError.sceAuth(xdr.ScErrorCode.scecInvalidAction)),
        ],
        value: xdr.ScVal.scvString("failed account authentication with error"),
      }),
    ]).tree;

    assert.equal(tree[0]?.error, "SystemError(scecInvalidAction)");
    // A host error is the VM speaking, not the guard, so the reason vocabulary
    // deliberately does not claim it.
    assert.equal(tree[0]?.errorExplanation?.recognized, false);
    assert.equal(tree[0]?.errorExplanation?.raw, "scecInvalidAction");
  });
});

describe("symbolic guard codes (#312)", () => {
  test("a reason symbol is explained from the SDK vocabulary", () => {
    const tree = parseDiagnosticLogs([
      { type: "error", contractId: MOCK_GUARD, functionName: "transfer", error: "admin_frozen" },
    ]).tree;

    assert.equal(tree[0]?.errorExplanation?.reason, "admin_frozen");
    assert.equal(tree[0]?.errorExplanation?.recognized, true);
    assert.match(tree[0]?.error ?? "", /admin froze the account/i);
  });

  test("an unrecognized symbol keeps its raw spelling and says it is unknown", () => {
    const tree = parseDiagnosticLogs([
      {
        type: "error",
        contractId: MOCK_GUARD,
        functionName: "transfer",
        error: "ledger_grace_period_expired",
      },
    ]).tree;

    assert.equal(tree[0]?.errorExplanation?.raw, "ledger_grace_period_expired");
    assert.equal(tree[0]?.errorExplanation?.reason, null);
    assert.equal(tree[0]?.errorExplanation?.recognized, false);
    assert.match(tree[0]?.error ?? "", /ledger_grace_period_expired/);
    assert.match(tree[0]?.error ?? "", /not recognized|Unrecognized/);
  });

  test("the empty symbol an allowed decision carries is not read as a reason", () => {
    // `event_auth_checked` publishes `""` as the third topic for an *allowed*
    // decision. Rendering that as a name would invent a refusal.
    const tree = parseDiagnosticLogs([{ type: "error", error: "" }]).tree;
    assert.equal(tree[0]?.errorExplanation?.recognized, false);
    assert.equal(tree[0]?.errorExplanation?.reason, null);
  });
});

describe("truncated and malformed diagnostics (#312)", () => {
  test("a truncated contract error never becomes a guessed code", () => {
    const tree = parseDiagnosticLogs(["Error(Contract, #"]).tree;
    // No digits means no code: the text is kept as a log line rather than being
    // classified, so nothing is invented from half a sentence.
    assert.equal(tree[0]?.error, undefined);
    assert.equal(tree[0]?.errorExplanation, undefined);
  });

  test("digits without a closing frame are still not read as a code", () => {
    // `Error(Contract, #2` is a cut-off string, not a host error the SDK ever
    // emitted. Matching it would let one stray digit name a refusal.
    const tree = parseDiagnosticLogs(["Error(Contract, #2"]).tree;
    assert.equal(tree[0]?.error, undefined);
    assert.equal(tree[0]?.errorExplanation, undefined);
  });

  test("a truncated XDR record is kept as text, not decoded into a reason", () => {
    const whole = errorEvent(KNOWN_CODE);
    const tree = parseDiagnosticLogs([whole.slice(0, Math.floor(whole.length / 2))]).tree;
    assert.equal(tree[0]?.error, undefined);
    assert.equal(tree[0]?.errorExplanation, undefined);
  });

  test("undecodable XDR is quoted as text rather than parsed into a reason", () => {
    const tree = parseDiagnosticLogs(["not-base64-at-all-###"]).tree;
    assert.equal(tree[0]?.error, undefined);
    assert.equal(tree[0]?.errorExplanation, undefined);
  });

  test("an error record with no code reports that nothing was recorded", () => {
    const tree = parseDiagnosticLogs([{ type: "error", contractId: MOCK_GUARD }]).tree;

    assert.equal(tree[0]?.errorExplanation?.raw, null);
    assert.equal(tree[0]?.errorExplanation?.reason, null);
    assert.equal(tree[0]?.errorExplanation?.recognized, false);
    assert.match(tree[0]?.error ?? "", /no guard error code was present/i);
    assert.doesNotMatch(tree[0]?.error ?? "", /UnknownError/, "no invented classification");
  });

  test("a malformed errorScVal falls back to the same admission", () => {
    const tree = parseDiagnosticLogs([
      { type: "error", errorScVal: { not: "an scval" }, message: undefined },
    ]).tree;

    assert.equal(tree[0]?.errorExplanation?.raw, null);
    assert.equal(tree[0]?.errorExplanation?.recognized, false);
    assert.match(tree[0]?.error ?? "", /no guard error code was present/i);
  });

  test("a refusal with an unknown reason is still marked as an error, never as a clean frame", () => {
    // The failure this guards against: a blocked call whose reason is
    // unrecognizable collapsing into a frame that reads like an approved
    // transaction. A refused call rolls back, so there is no `fn_return` after
    // it — the frame has to stay marked as the failure it is.
    const tree = parseDiagnosticLogs([
      fnCall(MOCK_GUARD, "transfer"),
      errorEvent(UNKNOWN_CODE),
    ]).tree;

    assert.ok(tree[0]?.error, "the frame keeps an error even when the code is unknown");
    assert.equal(tree[0]?.errorExplanation?.recognized, false);
    assert.equal(tree[0]?.events.length, 0, "no return was recorded for a rolled-back call");
  });

  test("a null or non-object event list entry is skipped without inventing a frame", () => {
    assert.deepEqual(parseDiagnosticLogs([null, undefined, 7]).tree, []);
  });
});

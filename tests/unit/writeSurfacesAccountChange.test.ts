/**
 * The wallet can change account between the review and the signature, and every
 * write surface has to refuse rather than commit for the new account (issue
 * #349).
 *
 * The matrix below drives the four write paths the console exposes — a policy
 * update, a panic action, a deployment, and an imported-XDR submission — with
 * the same deterministic mock wallet: its live address stays on the reviewed
 * account until the moment the write would commit, then moves.
 *
 * Two assertions matter on every row: no signature is requested for an account
 * the review was not built for, and nothing is broadcast at all. The third is
 * recovery — once the wallet is back on the reviewed account, a *fresh* review
 * succeeds, because an interruption never stores an envelope and never resubmits.
 *
 * The two panel-owned surfaces are additionally pinned by source: the deploy
 * path must call the write boundary before it signs and before it broadcasts,
 * and the imported-envelope panel must ask its account question before its
 * broadcast.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  Account,
  Asset,
  Keypair,
  Operation,
  SorobanDataBuilder,
  Transaction,
  TransactionBuilder,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import { freezeGuard, installPolicy, submitOperation } from "../../lib/guard/guardOps.ts";
import { EMPTY_DRAFT, type PolicyDraft } from "../../lib/guard/policyForm.ts";
import type { InvokeResult, WalletSigner } from "../../lib/guard/submit.ts";
import {
  clearWriteInterruption,
  getWriteInterruption,
  recoveryGuidance,
  reviewedAccountCheck,
  type WritePhase,
} from "../../lib/guard/writeReview.ts";

const PASSPHRASE = "Test SDF Network ; September 2015";
const GUARD = "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44";

/** The same two identities on every run, so a failure is reproducible. */
const REVIEWED = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(1));
const OTHER_ACCOUNT = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(2)).publicKey();

/** A policy the form's own validator accepts, so the write really starts. */
function validDraft(): PolicyDraft {
  return {
    ...EMPTY_DRAFT,
    perTxCap: "1000",
    windowCap: "5000",
    windowSecs: "86400",
    allowAnyRecipient: true,
    dmsGraceSecs: "3600",
  };
}

/**
 * A fake RPC that records broadcasts and answers the reads a write needs.
 *
 * `sendCalls` is the outcome that matters here: a surface that broadcasts under
 * the wrong account leaves a mark in it, so every assertion about "nothing was
 * sent" is really an assertion about that array.
 */
function recordingServer(sendCalls: string[]): rpc.Server {
  const successfulSimulation = () => {
    const data = new SorobanDataBuilder()
      .setReadWrite([])
      .setResourceFee(BigInt(500))
      .setResources(1_000_000, 0, 0)
      .build();
    return {
      transactionData: new SorobanDataBuilder(data),
      minResourceFee: "500",
      result: { auth: [], retval: xdr.ScVal.scvVoid() },
      events: [],
      latestLedger: 200,
      cost: { cpuInsns: "0", memBytes: "0" },
      stateChanges: [],
    };
  };
  return {
    getAccount: async (address: string) => new Account(address, "1"),
    simulateTransaction: async () => successfulSimulation(),
    prepareTransaction: async (transaction: unknown) => transaction,
    sendTransaction: async () => {
      sendCalls.push("sent");
      return { status: "PENDING", hash: "ab".repeat(32), latestLedger: 200 };
    },
    getTransaction: async () => ({
      status: rpc.Api.GetTransactionStatus.SUCCESS,
      ledger: 201,
      hash: "ab".repeat(32),
    }),
  } as unknown as rpc.Server;
}

/** A signer whose live address is whatever the test says it is right now. */
function signerWith(options: {
  liveAddress: () => string | null;
  onSign?: () => void;
}): WalletSigner {
  return {
    address: REVIEWED.publicKey(),
    currentAddress: async () => options.liveAddress(),
    signTransaction: async (transactionXdr: string) => {
      options.onSign?.();
      const transaction = TransactionBuilder.fromXDR(transactionXdr, PASSPHRASE) as Transaction;
      transaction.sign(REVIEWED);
      return transaction.toXDR();
    },
    signAuthEntry: async () => {
      throw new Error("these calls need no authorization entries");
    },
  };
}

/** What every refused write must show, whatever surface produced it. */
function assertRefusedForAccountChange(
  result: InvokeResult,
  phase: WritePhase,
  sendCalls: string[],
): void {
  assert.equal(result.kind, "refused");
  if (result.kind !== "refused") return;
  assert.equal(result.stage, "wallet");

  const interruption = result.writeInterruption;
  assert.ok(interruption, "the write reports the interruption to the wallet panel");
  if (!interruption) return;
  assert.equal(interruption.kind, "account-changed");
  assert.equal(interruption.phase, phase);
  assert.deepEqual(sendCalls, [], "nothing may be broadcast");

  const guidance = recoveryGuidance(interruption);
  assert.equal(guidance.autoResubmit, false, "recovery never replays a write");
  assert.equal(guidance.persistEnvelope, false, "no envelope is kept for a retry");
}

describe("policy updates", () => {
  it("refuses set_policy when the wallet moved before the envelope signature", async () => {
    const sendCalls: string[] = [];
    let signed = 0;
    const outcome = await installPolicy({
      server: recordingServer(sendCalls),
      signer: signerWith({
        liveAddress: () => OTHER_ACCOUNT,
        onSign: () => {
          signed += 1;
        },
      }),
      guard: GUARD,
      draft: validDraft(),
    });

    assert.equal(outcome.kind, "invoked", `the draft must build: ${JSON.stringify(outcome)}`);
    if (outcome.kind !== "invoked") return;
    const result = outcome.result;
    assertRefusedForAccountChange(result, "envelope", sendCalls);
    assert.equal(signed, 0, "the envelope is never signed for another account");
    assert.equal(result.kind, "refused");
    if (result.kind !== "refused") return;
    assert.match(result.detail, /fresh review/i, "the operator is told to start again");
  });

  it("refuses set_policy when the wallet moved between signature and broadcast", async () => {
    const sendCalls: string[] = [];
    let signed = 0;
    let reads = 0;
    // Review and signature happen on the reviewed account; the move is noticed
    // only at the last boundary — which is the one that has to stop the send.
    const liveAddress = (): string => {
      reads += 1;
      if (reads === 1) return REVIEWED.publicKey();
      return OTHER_ACCOUNT;
    };
    const outcome = await installPolicy({
      server: recordingServer(sendCalls),
      signer: signerWith({
        liveAddress,
        onSign: () => {
          signed += 1;
        },
      }),
      guard: GUARD,
      draft: validDraft(),
    });

    assert.equal(outcome.kind, "invoked");
    if (outcome.kind !== "invoked") return;
    assertRefusedForAccountChange(outcome.result, "submission", sendCalls);
    assert.equal(signed, 1, "the signature it produced was for the reviewed account");
  });
});

describe("panic actions", () => {
  it("refuses a freeze when the wallet moved before the envelope signature", async () => {
    const sendCalls: string[] = [];
    let signed = 0;
    const result = await freezeGuard({
      server: recordingServer(sendCalls),
      signer: signerWith({
        liveAddress: () => OTHER_ACCOUNT,
        onSign: () => {
          signed += 1;
        },
      }),
      guard: GUARD,
    });

    assertRefusedForAccountChange(result, "envelope", sendCalls);
    assert.equal(signed, 0, "the panic button must not sign from another account");
    assert.equal(result.kind, "refused");
    if (result.kind !== "refused") return;
    assert.match(result.detail, /fresh review/i, "the panel is told to review again");
  });
});

describe("deployment", () => {
  it("refuses a deploy operation when the wallet moved before signing", async () => {
    const sendCalls: string[] = [];
    let signed = 0;
    const result = await submitOperation({
      server: recordingServer(sendCalls),
      signer: signerWith({
        liveAddress: () => OTHER_ACCOUNT,
        onSign: () => {
          signed += 1;
        },
      }),
      operation: Operation.payment({
        source: REVIEWED.publicKey(),
        destination: OTHER_ACCOUNT,
        asset: Asset.native(),
        amount: "1",
      }),
      label: "deploy path (issue #349 matrix)",
    });

    assertRefusedForAccountChange(result, "envelope", sendCalls);
    assert.equal(signed, 0, "a deployment is never signed by the moved wallet");
  });

  it("calls the write boundary before it signs and before it broadcasts", () => {
    const source = readFileSync("lib/guard/guardOps.ts", "utf8");
    const beforeSign = source.indexOf('writeBoundary(signer, "envelope")');
    const sign = source.indexOf("signer.signTransaction(");
    const beforeSend = source.indexOf('writeBoundary(signer, "submission")');
    const send = source.indexOf("server.sendTransaction(");

    assert.ok(beforeSign > 0, "the deploy path re-reads the wallet before signing");
    assert.ok(beforeSign < sign, "…and does so before the signature is requested");
    assert.ok(beforeSend > 0, "…and again before anything is broadcast");
    assert.ok(beforeSend < send, "…ahead of the network call itself");
  });
});

describe("imported-XDR submission", () => {
  it("refuses to broadcast an envelope reviewed for a different account", () => {
    const reviewedSource = REVIEWED.publicKey();

    assert.equal(
      reviewedAccountCheck({ reviewedSource, liveAddress: reviewedSource }).ok,
      true,
      "the wallet still on the reviewed account may broadcast",
    );

    const moved = reviewedAccountCheck({ reviewedSource, liveAddress: OTHER_ACCOUNT });
    assert.equal(moved.ok, false);
    if (moved.ok) return;
    assert.match(moved.message, /Nothing was broadcast/);
    assert.match(moved.message, /fresh review/i);
    const named = moved.message.match(/…/g) ?? [];
    assert.equal(named.length, 2, "both shortened addresses are named for the operator");
  });

  it("stops when the provider is gone, and carries on unattended when there is none", () => {
    const reviewedSource = REVIEWED.publicKey();

    const gone = reviewedAccountCheck({ reviewedSource, liveAddress: null });
    assert.equal(gone.ok, false);
    if (!gone.ok) assert.match(gone.message, /disconnected/);

    // No wallet connected at all: this panel has always broadcast an externally
    // signed envelope without one, and that is not what this issue changes.
    assert.equal(reviewedAccountCheck({ reviewedSource, liveAddress: undefined }).ok, true);
  });

  it("asks the account question before it hands the envelope to the network", () => {
    const panel = readFileSync("components/SubmitSignedXDRPanel.tsx", "utf8");
    const check = panel.indexOf("reviewedAccountCheck(");
    const broadcast = panel.indexOf("server.sendTransaction(");

    assert.ok(check > 0, "the panel uses the shared account check");
    assert.ok(broadcast > check, "the check runs before the broadcast");
  });
});

describe("recovery", () => {
  it("succeeds on a fresh review once the wallet is back, with nothing stored", async () => {
    clearWriteInterruption();
    const sendCalls: string[] = [];
    let onAnotherAccount = true;
    const liveAddress = (): string => {
      if (onAnotherAccount) return OTHER_ACCOUNT;
      return REVIEWED.publicKey();
    };
    const signer = signerWith({ liveAddress });

    const refused = await installPolicy({
      server: recordingServer(sendCalls),
      signer,
      guard: GUARD,
      draft: validDraft(),
    });
    assert.equal(refused.kind, "invoked");
    if (refused.kind !== "invoked") return;
    assertRefusedForAccountChange(refused.result, "envelope", sendCalls);

    // The interruption is what tells the wallet panel to demand a new review —
    // and it survives until the operator dismisses it, so the state that stops
    // a second attempt cannot silently expire between the two.
    const recorded = getWriteInterruption();
    assert.equal(recorded?.interruption.kind, "account-changed");
    assert.match(
      recoveryGuidance(recorded!.interruption).nextStep,
      /fresh review/i,
      "the guidance never says “retry this one”",
    );

    // The operator switches back. The next attempt is a *fresh* review — the
    // refused one is not resumed, replayed, or completed from a stored envelope.
    onAnotherAccount = false;
    const retried = await installPolicy({
      server: recordingServer(sendCalls),
      signer,
      guard: GUARD,
      draft: validDraft(),
    });
    assert.equal(retried.kind, "invoked");
    if (retried.kind !== "invoked") return;
    assert.equal(retried.result.kind, "submitted", "a fresh review on the right account lands");
    assert.deepEqual(sendCalls, ["sent"], "exactly one broadcast, for the reviewed account");

    clearWriteInterruption();
    assert.equal(getWriteInterruption(), null, "dismissing the notice clears the panel state");
  });
});

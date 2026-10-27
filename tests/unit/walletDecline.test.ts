/**
 * A wallet rejection is a decision, not a failure (issue #291).
 *
 * Two things have to hold for an operator who presses Cancel: the outcome they
 * read must say what actually did not happen (no signature, no broadcast) and
 * must not be worded like a simulation, RPC or on-chain failure — and the only
 * way anything runs again is an explicit second attempt, which re-reads the
 * account, re-simulates and builds a new sequence-bound transaction. Both are
 * decided in plain functions here, so the wording can be asserted without an
 * extension, a chain, or a React tree.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Account, Keypair, Operation, rpc } from "@stellar/stellar-sdk";
import { classifyDeploySteps, submitOperation, type DeployStep } from "../../lib/guard/guardOps.ts";
import { deployOutcomeView, initOutcomeView } from "../../components/DeployPanel.tsx";
import { WalletUserRejectedError } from "../../lib/guard/walletConnector.ts";
import type { InvokeResult, WalletSigner } from "../../lib/guard/submit.ts";

const PASSPHRASE = "Test SDF Network ; September 2015";
const UPLOAD_LABEL = "upload_contract_wasm (1234 bytes)";
const CREATE_LABEL = "create_custom_contract (wasm f47919f92e78…) → CAAAAAAA";
const DECLINE_WORDS = "You declined to sign this transaction in Freighter. Nothing was sent.";

const declined: InvokeResult = { kind: "cancelled", detail: DECLINE_WORDS };
const refused: InvokeResult = {
  kind: "refused",
  stage: "enforcement",
  detail: "host invocation failed: Error(Contract, InvalidAction)",
  diagnosticEvents: [],
};
const failed: InvokeResult = {
  kind: "failed",
  hash: "cd".repeat(32),
  detail: "transaction was included and rejected (tx_failed)",
  diagnosticEvents: [],
};
const submitted: InvokeResult = {
  kind: "submitted",
  hash: "ab".repeat(32),
  status: "SUCCESS",
  ledger: 201,
  events: null,
};

function step(label: string, result: InvokeResult): DeployStep {
  return { label, result };
}

function outcome(
  steps: DeployStep[],
  overrides: Partial<Parameters<typeof deployOutcomeView>[0]> = {},
) {
  return {
    guard: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    steps,
    identity: null,
    readError: null,
    verified: false,
    ...overrides,
  };
}

describe("classifyDeploySteps", () => {
  it("reads a decline when the create was never signed", () => {
    const progress = classifyDeploySteps([step(CREATE_LABEL, declined)]);
    assert.equal(progress.kind, "declined");
    assert.deepEqual(progress.kind === "declined" && progress.landed, []);
    assert.equal(progress.kind === "declined" && progress.detail, DECLINE_WORDS);
  });

  it("reports an earlier step that did reach the network alongside the decline", () => {
    const progress = classifyDeploySteps([
      step(UPLOAD_LABEL, submitted),
      step(CREATE_LABEL, declined),
    ]);
    assert.equal(progress.kind, "declined");
    assert.deepEqual(progress.kind === "declined" && progress.landed, [UPLOAD_LABEL]);
  });

  it("keeps a pre-broadcast refusal, an on-chain rejection and a decline apart", () => {
    assert.equal(classifyDeploySteps([step(CREATE_LABEL, refused)]).kind, "refused");
    assert.equal(classifyDeploySteps([step(CREATE_LABEL, failed)]).kind, "failed");
    assert.equal(classifyDeploySteps([step(CREATE_LABEL, submitted)]).kind, "created");
  });

  it("does not claim anything landed when no step ran", () => {
    const progress = classifyDeploySteps([]);
    assert.equal(progress.kind, "refused");
    assert.deepEqual(progress.kind === "refused" && progress.landed, []);
  });
});

describe("the deploy panel's outcome wording (#291)", () => {
  it("says the deploy was declined and that nothing was broadcast", () => {
    const view = deployOutcomeView(outcome([step(CREATE_LABEL, declined)]));
    assert.match(view.headline, /declined in the wallet/i);
    assert.match(view.headline, /nothing was broadcast/i);
    assert.equal(view.tone, "warn");
    assert.equal(view.retryable, true, "an explicit retry is the safe next step");
    assert.equal(view.detail, DECLINE_WORDS);
  });

  it("still says the upload landed when only the create was declined", () => {
    const view = deployOutcomeView(
      outcome([step(UPLOAD_LABEL, submitted), step(CREATE_LABEL, declined)]),
    );
    assert.match(view.headline, /earlier step landed/i);
    assert.equal(view.retryable, true);
  });

  it("does not report a simulation or submission refusal as a decline", () => {
    const view = deployOutcomeView(outcome([step(CREATE_LABEL, refused)]));
    assert.match(view.headline, /refused before broadcast/i);
    assert.doesNotMatch(view.headline, /declined|rejected on chain/i);
    assert.equal(view.tone, "error");
    assert.equal(view.retryable, false, "a refusal is not cleared by pressing retry again");
  });

  it("does not report an on-chain rejection as a refusal before broadcast", () => {
    const view = deployOutcomeView(outcome([step(CREATE_LABEL, failed)]));
    assert.match(view.headline, /included and rejected on chain/i);
    assert.equal(view.tone, "error");
    assert.equal(view.retryable, false);
  });

  it("keeps the three created-contract headlines it always had", () => {
    assert.equal(
      deployOutcomeView(outcome([step(CREATE_LABEL, submitted)], { verified: true })).headline,
      "Deployed and verified against the pinned artifact",
    );
    assert.equal(
      deployOutcomeView(
        outcome([step(CREATE_LABEL, submitted)], {
          verified: false,
          readError: "rpc timeout",
        }),
      ).headline,
      "A contract was created, but its bytecode could not be read back",
    );
    assert.equal(
      deployOutcomeView(outcome([step(CREATE_LABEL, submitted)])).headline,
      "A contract was created, but it is NOT the pinned artifact",
    );
  });
});

describe("the initialize panel's outcome wording (#291)", () => {
  it("reports a decline as a decline, not as a broadcast rejection", () => {
    const view = initOutcomeView(declined);
    assert.match(view.headline, /declined in the wallet/i);
    assert.match(view.headline, /nothing was broadcast/i);
    assert.doesNotMatch(view.headline, /rejected on chain/i);
    assert.equal(view.tone, "warn");
    assert.equal(view.retryable, true);
    assert.equal(view.detail, DECLINE_WORDS);
  });

  it("reports a pre-broadcast refusal without claiming a broadcast", () => {
    const view = initOutcomeView(refused);
    assert.match(view.headline, /refused before broadcast/i);
    assert.equal(view.tone, "error");
    assert.equal(view.retryable, false);
  });

  it("reports an on-chain rejection as exactly that", () => {
    const view = initOutcomeView(failed);
    assert.match(view.headline, /broadcast and rejected on chain/i);
    assert.equal(view.tone, "error");
    assert.equal(view.retryable, false);
  });

  it("reports an exported envelope as not broadcast", () => {
    const view = initOutcomeView({ kind: "exported", xdr: "AAAA" });
    assert.match(view.headline, /exported for offline signing/i);
    assert.match(view.headline, /nothing was broadcast/i);
    assert.equal(view.retryable, false, "an export is finished work, not a failure to retry");
  });

  it("reports a landed initialize as landed", () => {
    const view = initOutcomeView(submitted);
    assert.match(view.headline, /landed on chain/i);
    assert.equal(view.tone, "info");
    assert.equal(view.retryable, false);
  });
});

describe("submitOperation after a decline (#291)", () => {
  function rejectingSigner(onPrompt?: () => void): WalletSigner {
    const keypair = Keypair.random();
    return {
      address: keypair.publicKey(),
      currentAddress: async () => keypair.publicKey(),
      async signTransaction(): Promise<string> {
        onPrompt?.();
        throw new WalletUserRejectedError("freighter", "sign this transaction");
      },
      async signAuthEntry(): Promise<string> {
        throw new Error("host-function operations have no authorization entries");
      },
    };
  }

  function server(sent: string[]): rpc.Server {
    return {
      getAccount: async (address: string) => new Account(address, "1"),
      prepareTransaction: async (transaction: unknown) => transaction,
      sendTransaction: async () => {
        sent.push("sent");
        return { status: "PENDING", hash: "ab".repeat(32), latestLedger: 200 };
      },
      getTransaction: async () => {
        assert.fail("nothing was broadcast, so there is no transaction to poll");
      },
    } as unknown as rpc.Server;
  }

  it("ends the deploy step as cancelled instead of throwing at the operator", async () => {
    const sent: string[] = [];
    let prompts = 0;
    const result = await submitOperation({
      server: server(sent),
      signer: rejectingSigner(() => {
        prompts += 1;
      }),
      operation: Operation.uploadContractWasm({ wasm: new Uint8Array([0x00, 0x61, 0x73, 0x6d]) }),
      label: "upload_contract_wasm",
      passphrase: PASSPHRASE,
    });

    assert.equal(result.kind, "cancelled");
    assert.match(result.kind === "cancelled" ? result.detail : "", /declined/i);
    assert.equal(prompts, 1, "no implicit second prompt");
    assert.deepEqual(sent, [], "a declined deploy step never reaches the network");
  });

  it("still surfaces a signer failure that is not a decline", async () => {
    const sent: string[] = [];
    const keypair = Keypair.random();
    const signer: WalletSigner = {
      address: keypair.publicKey(),
      async signTransaction(): Promise<string> {
        throw new Error("the provider crashed");
      },
      async signAuthEntry(): Promise<string> {
        throw new Error("not used");
      },
    };

    await assert.rejects(
      () =>
        submitOperation({
          server: server(sent),
          signer,
          operation: Operation.uploadContractWasm({
            wasm: new Uint8Array([0x00, 0x61, 0x73, 0x6d]),
          }),
          label: "upload_contract_wasm",
          passphrase: PASSPHRASE,
        }),
      /the provider crashed/,
      "only a decline is classified; other errors keep their old path",
    );
    assert.deepEqual(sent, []);
  });
});

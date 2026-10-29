import assert from "node:assert/strict";
import { test } from "node:test";
import { Keypair } from "@stellar/stellar-sdk";
import { deployGuard } from "../../lib/guard/guardOps.ts";
import { predictContractId } from "../../lib/guard/chain.ts";

test("an existing predicted instance stops deployment before any write or wallet prompt", async () => {
  const signerAddress = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(7)).publicKey();
  const salt = new Uint8Array(32).fill(9);
  const predicted = await predictContractId({ deployerPublicKey: signerAddress, salt });
  const lookups: string[] = [];
  let preparedTransactions = 0;
  let prompts = 0;
  const server = {
    getContractInstance: async (address: string) => {
      lookups.push(address);
      if (address === predicted) return { executable: { type: "contractExecutableWasm" } };
      throw Object.assign(new Error("not found"), { code: 404 });
    },
    prepareTransaction: async () => {
      preparedTransactions += 1;
      throw new Error("must not prepare a transaction");
    },
  } as any;
  const signer = {
    address: signerAddress,
    signAuthEntry: async () => {
      prompts += 1;
      throw new Error("must not prompt for auth");
    },
    signTransaction: async () => {
      prompts += 1;
      throw new Error("must not prompt for a transaction");
    },
  };

  await assert.rejects(deployGuard({ server, signer, salt }), /already exists/);
  assert.deepEqual(lookups, [predicted], "check the predicted address before artifact reads");
  assert.equal(preparedTransactions, 0);
  assert.equal(prompts, 0);
});

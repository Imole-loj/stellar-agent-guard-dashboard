import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { explainEndpointRoles, ENDPOINT_ROLES } from "../../lib/guard/network.ts";
import {
  detectNetworkMismatch,
  describeMismatch,
  mismatchExplanation,
  TESTNET_PASSPHRASE,
  PUBLIC_PASSPHRASE,
  FUTURENET_PASSPHRASE,
} from "../../lib/guard/networkSwitch.ts";

describe("Issue #508 - Explain read-only versus write endpoint configuration", () => {
  describe("Endpoint setting role explanations", () => {
    it("clearly defines the read-only RPC endpoint role as non-custodial without signing", () => {
      const roles = explainEndpointRoles();

      assert.match(
        roles.readOnlyRole,
        /non-custodial queries/i,
        "Must explain that read-only endpoint is for non-custodial queries",
      );
      assert.match(
        roles.readOnlyRole,
        /holds no keys/i,
        "Must state that read-only endpoint holds no keys",
      );
      assert.match(
        roles.readOnlyRole,
        /cannot authorize transactions/i,
        "Must state that read-only endpoint cannot authorize transactions",
      );
    });

    it("clearly defines the write network role as the wallet domain for transaction signatures", () => {
      const roles = explainEndpointRoles();

      assert.match(
        roles.writeRole,
        /wallet/i,
        "Must state that write network is the wallet domain",
      );
      assert.match(
        roles.writeRole,
        /signs and broadcasts transactions/i,
        "Must state that transactions are signed and broadcast on write network",
      );
      assert.match(
        roles.writeRole,
        /Changing the read endpoint does not alter/i,
        "Must explicitly explain that changing read endpoint does not alter write network",
      );
    });
  });

  describe("Network mismatch detection and remediation explanation", () => {
    it("detects mismatch when wallet is on Mainnet and dashboard target is Testnet", () => {
      const mismatch = detectNetworkMismatch(PUBLIC_PASSPHRASE, TESTNET_PASSPHRASE, {
        targetNetwork: "testnet",
        walletNetwork: "public",
      });

      assert.notEqual(mismatch, null);
      if (mismatch) {
        assert.equal(describeMismatch(mismatch), "Wallet on Mainnet, dashboard on Testnet.");
        const explanation = mismatchExplanation(mismatch);
        assert.match(
          explanation,
          /A signature produced for Mainnet cannot authorize a call on Testnet/,
        );
      }
    });

    it("detects mismatch when wallet is on Futurenet and dashboard target is Testnet", () => {
      const mismatch = detectNetworkMismatch(FUTURENET_PASSPHRASE, TESTNET_PASSPHRASE, {
        targetNetwork: "testnet",
        walletNetwork: "futurenet",
      });

      assert.notEqual(mismatch, null);
      if (mismatch) {
        assert.equal(describeMismatch(mismatch), "Wallet on Futurenet, dashboard on Testnet.");
      }
    });

    it("treats missing or empty wallet passphrase as a mismatch failure state", () => {
      const mismatch = detectNetworkMismatch(null, TESTNET_PASSPHRASE, {
        targetNetwork: "testnet",
      });
      assert.notEqual(mismatch, null, "Must fail safe when wallet passphrase cannot be determined");
    });

    it("returns null when wallet and dashboard networks are fully aligned", () => {
      const mismatch = detectNetworkMismatch(TESTNET_PASSPHRASE, TESTNET_PASSPHRASE, {
        targetNetwork: "testnet",
      });
      assert.equal(mismatch, null, "Aligned networks must produce no mismatch");
    });
  });
});

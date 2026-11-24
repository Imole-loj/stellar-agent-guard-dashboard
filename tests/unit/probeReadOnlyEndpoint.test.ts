import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  probeReadOnlyEndpoint,
  resolveNetworkNameFromPassphrase,
  type ReadOnlyProbeResult,
} from "../../lib/guard/network.ts";
import { RpcPool } from "../../lib/guard/rpcPool.ts";

describe("Issue #506 - Operator-controlled read-only endpoint probe", () => {
  it("probes a documented read endpoint (`getNetwork`) and reports network identity and latency", async () => {
    let methodCalled: string | null = null;
    let requestBody: any = null;

    const fakeFetch: typeof fetch = async (_url, init) => {
      requestBody = JSON.parse(String(init?.body ?? "{}"));
      methodCalled = requestBody.method;

      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            passphrase: "Test SDF Network ; September 2015",
            protocolVersion: 22,
            friendbotUrl: "https://friendbot.stellar.org/",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    let clock = 1000;
    const now = () => {
      clock += 35; // simulate 35ms latency
      return clock;
    };

    const result = await probeReadOnlyEndpoint("https://soroban-testnet.stellar.org/rpc", {
      fetchImpl: fakeFetch,
      now,
    });

    assert.equal(methodCalled, "getNetwork", "Must query documented getNetwork method");
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.endpointOrigin, "https://soroban-testnet.stellar.org");
      assert.equal(result.passphrase, "Test SDF Network ; September 2015");
      assert.equal(result.protocolVersion, 22);
      assert.equal(result.networkName, "Testnet");
      assert.ok(result.latencyMs >= 35);
    }
  });

  it("RpcPool.probeEndpoint delegates to read-only probe", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            passphrase: "Public Global Stellar Network ; September 2015",
            protocolVersion: 22,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    const pool = new RpcPool("https://mainnet.stellar.org", []);
    const result = await pool.probeEndpoint(undefined, { fetchImpl: fakeFetch });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.networkName, "Mainnet");
      assert.equal(result.passphrase, "Public Global Stellar Network ; September 2015");
    }
  });

  it("reports failure when endpoint answer times out", async () => {
    const fakeFetch: typeof fetch = async (_url, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted", "AbortError"));
        });
      });
    };

    const result = await probeReadOnlyEndpoint("https://slow-rpc.test", {
      fetchImpl: fakeFetch,
      timeoutMs: 20,
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.failure, "timeout");
      assert.match(result.detail, /no answer within 20ms/);
    }
  });

  it("reports failure on non-2xx HTTP status", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response("Internal Server Error", { status: 503 });

    const result = await probeReadOnlyEndpoint("https://bad-gateway.test", {
      fetchImpl: fakeFetch,
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.failure, "unavailable");
      assert.match(result.detail, /HTTP 503/);
    }
  });

  it("reports failure on malformed or non-JSON response", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response("<!DOCTYPE html><html>error</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });

    const result = await probeReadOnlyEndpoint("https://malformed.test", {
      fetchImpl: fakeFetch,
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.failure, "malformed");
    }
  });

  it("redacts endpoint credentials when reporting probe network errors", async () => {
    const fakeFetch: typeof fetch = async () => {
      throw new Error(
        "connect ECONNREFUSED https://ops:supersecret123@rpc.test:443/rpc?token=tok_456",
      );
    };

    const result = await probeReadOnlyEndpoint(
      "https://ops:supersecret123@rpc.test/rpc?token=tok_456",
      {
        fetchImpl: fakeFetch,
      },
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.failure, "network");
      assert.equal(result.endpointOrigin, "https://rpc.test");
      assert.doesNotMatch(result.detail, /supersecret123/);
      assert.doesNotMatch(result.detail, /tok_456/);
      assert.match(result.detail, /\[redacted\]/);
    }
  });

  it("never executes transactions, signs envelopes, or mutates chain state", async () => {
    let postCount = 0;
    let bodies: string[] = [];

    const interceptFetch: typeof fetch = async (_url, init) => {
      postCount += 1;
      const body = String(init?.body ?? "");
      bodies.push(body);
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            passphrase: "Test SDF Future Network ; October 2022",
            protocolVersion: 22,
          },
        }),
      );
    };

    const result = await probeReadOnlyEndpoint("https://futurenet.stellar.org", {
      fetchImpl: interceptFetch,
    });

    assert.equal(result.ok, true);
    assert.equal(postCount, 1);
    assert.match(bodies[0] ?? "", /"method":"getNetwork"/);
    assert.doesNotMatch(bodies[0] ?? "", /sendTransaction/);
    assert.doesNotMatch(bodies[0] ?? "", /simulateTransaction/);
  });

  it("resolveNetworkNameFromPassphrase correctly maps known and custom networks", () => {
    assert.equal(resolveNetworkNameFromPassphrase("Test SDF Network ; September 2015"), "Testnet");
    assert.equal(
      resolveNetworkNameFromPassphrase("Public Global Stellar Network ; September 2015"),
      "Mainnet",
    );
    assert.equal(
      resolveNetworkNameFromPassphrase("Test SDF Future Network ; October 2022"),
      "Futurenet",
    );
    assert.equal(
      resolveNetworkNameFromPassphrase("Standalone Network ; February 2024"),
      "Standalone",
    );
    assert.equal(resolveNetworkNameFromPassphrase("Local Sandbox Network"), "Standalone");
    assert.equal(resolveNetworkNameFromPassphrase("Private Enterprise Ledger"), "Custom Network");
    assert.equal(resolveNetworkNameFromPassphrase(""), "Unknown Network");
  });
});

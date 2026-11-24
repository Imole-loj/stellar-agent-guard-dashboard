import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  redactEndpointUrl,
  safeCopyEndpoint,
  sanitizeEndpointOrigin,
  buildReadDiagnostic,
  redactDiagnosticText,
  DIAGNOSTIC_REDACTED,
} from "../../lib/guard/network.ts";
import { RpcPool } from "../../lib/guard/rpcPool.ts";

describe("Issue #507 - Centralized endpoint credential redaction across diagnostic surfaces", () => {
  describe("redactEndpointUrl", () => {
    it("redacts userinfo credentials in URLs", () => {
      const url = "https://admin:superSecretPass123@soroban-testnet.stellar.org/soroban/rpc";
      const redacted = redactEndpointUrl(url);

      assert.doesNotMatch(redacted, /superSecretPass123/);
      assert.doesNotMatch(redacted, /admin/);
      assert.match(redacted, /https:\/\/\[redacted\]@soroban-testnet\.stellar\.org\/soroban\/rpc/);
    });

    it("redacts query string tokens and API keys", () => {
      const url =
        "https://rpc.example.test/soroban?token=secret-token-abc&apiKey=ak_live_xyz999&limit=50";
      const redacted = redactEndpointUrl(url);

      assert.doesNotMatch(redacted, /secret-token-abc/);
      assert.doesNotMatch(redacted, /ak_live_xyz999/);
      assert.match(redacted, /token=\[redacted\]/);
      assert.match(redacted, /apiKey=\[redacted\]/);
    });

    it("redacts both userinfo and query credentials simultaneously", () => {
      const url = "https://ops:hunter2@rpc.provider.org:8080/path?access_token=secret_tok_123#frag";
      const redacted = redactEndpointUrl(url);

      assert.doesNotMatch(redacted, /hunter2/);
      assert.doesNotMatch(redacted, /ops/);
      assert.doesNotMatch(redacted, /secret_tok_123/);
      assert.equal(
        redacted,
        "https://[redacted]@rpc.provider.org:8080/path?access_token=[redacted]#frag",
      );
    });

    it("handles malformed, partial, or empty input without throwing", () => {
      assert.equal(redactEndpointUrl(""), "");
      assert.equal(redactEndpointUrl(null as any), "");
      assert.equal(redactEndpointUrl(undefined as any), "");
      assert.equal(
        redactEndpointUrl("not a valid url but has ?token=secret123"),
        "not a valid url but has ?token=[redacted]",
      );
    });
  });

  describe("safeCopyEndpoint", () => {
    it("produces clean redacted strings for clipboard copy actions", () => {
      const rawEndpoint = "https://user:pass@rpc.test/soroban?secret=xyz";
      const copyPayload = safeCopyEndpoint(rawEndpoint);

      assert.doesNotMatch(copyPayload, /pass/);
      assert.doesNotMatch(copyPayload, /user/);
      assert.doesNotMatch(copyPayload, /xyz/);
      assert.equal(copyPayload, "https://[redacted]@rpc.test/soroban?secret=[redacted]");
    });
  });

  describe("sanitizeEndpointOrigin", () => {
    it("drops all credentials, paths, queries, and fragments, returning origin only", () => {
      const origin = sanitizeEndpointOrigin(
        "https://operator:password@soroban-testnet.stellar.org:443/soroban/rpc?api_key=ak_123#hash",
      );
      assert.equal(origin, "https://soroban-testnet.stellar.org");
    });
  });

  describe("buildReadDiagnostic surface", () => {
    it("redacts credentials from diagnostic payloads and copy text", () => {
      const diagnostic = buildReadDiagnostic({
        operation: "getLedgerEntries(?token=leak_token)",
        endpoint: "https://user:pass@soroban-testnet.stellar.org/soroban?api_key=ak_secret",
        network: "testnet?token=leaked_net_tok",
        at: new Date("2026-11-23T08:00:00.000Z"),
      });

      assert.doesNotMatch(diagnostic.text, /leak_token/);
      assert.doesNotMatch(diagnostic.text, /pass/);
      assert.doesNotMatch(diagnostic.text, /ak_secret/);
      assert.doesNotMatch(diagnostic.text, /leaked_net_tok/);
      assert.equal(diagnostic.endpointOrigin, "https://soroban-testnet.stellar.org");
      assert.match(diagnostic.text, /endpoint: https:\/\/soroban-testnet\.stellar\.org/);
    });
  });

  describe("RpcPool error surfaces", () => {
    it("redacts credentials from error messages thrown during fetch failures", async () => {
      const pool = new RpcPool(
        "https://auth_user:auth_pass_999@bad-host.test/rpc?key=sensitive_key_val",
        [],
      );

      // Stub globalThis.fetch to reject with an error mentioning the URL
      const origFetch = globalThis.fetch;
      globalThis.fetch = (async () => {
        throw new Error(
          "Fetch failed for https://auth_user:auth_pass_999@bad-host.test/rpc?key=sensitive_key_val: getaddrinfo ENOTFOUND",
        );
      }) as unknown as typeof fetch;

      try {
        await assert.rejects(
          async () => {
            await pool.fetch("/test");
          },
          (err: Error) => {
            assert.doesNotMatch(err.message, /auth_pass_999/);
            assert.doesNotMatch(err.message, /sensitive_key_val/);
            assert.match(err.message, /\[redacted\]/);
            return true;
          },
        );
      } finally {
        globalThis.fetch = origFetch;
      }
    });
  });
});

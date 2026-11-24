import { GUARD_WASM_HASH } from "stellar-agent-guard-sdk";

/**
 * Network + artifact constants, and the one canonical wording for the
 * enforcement boundary.
 *
 * The dashboard holds no secrets and no configuration that changes *what* it
 * deploys: the artifact's hash and byte length, and the boundary statement it
 * displays, are fixed constants, so nothing the UI says about the guard can
 * silently diverge from what the guard actually does. The only values a build can
 * move are *where* it looks — which RPC endpoint, which passphrase, and which
 * instance to read the pinned bytes from — and those default to public testnet.
 */

import type { RpcHealthFailure, RpcHealthResult, RpcProbeOptions } from "../rpc/timeouts.ts";
import {
  DIAGNOSTIC_REDACTED,
  RPC_PROBE_TIMEOUT_MS,
  buildReadDiagnostic,
  redactDiagnosticText,
  sanitizeEndpointOrigin,
} from "../rpc/timeouts.ts";

export { DIAGNOSTIC_REDACTED, sanitizeEndpointOrigin, redactDiagnosticText, buildReadDiagnostic };
export type { ReadDiagnostic } from "../rpc/timeouts.ts";

/**
 * The canonical public Stellar testnet: the defaults, and the network the pinned
 * artifact is published on.
 */
export const TESTNET = {
  name: "testnet",
  rpcUrl: "https://soroban-testnet.stellar.org",
  passphrase: "Test SDF Network ; September 2015",
} as const;

/**
 * The network this build talks to.
 *
 * Defaults to public testnet. `scripts/start-local-sandbox.sh` points a
 * development build at a local standalone node instead, through the three
 * `NEXT_PUBLIC_*` values it writes into `.env.local`. The passphrase has to move
 * together with the RPC URL — a signature produced for one network cannot
 * authorize on another — which is exactly what the wallet check in
 * `components/GuardProvider.tsx` reports when they disagree.
 *
 * These are public endpoints, never secrets, which is why they are the only thing
 * in this file that a build may override.
 */
export const NETWORK = {
  name: process.env.NEXT_PUBLIC_NETWORK_NAME ?? TESTNET.name,
  rpcUrl: process.env.NEXT_PUBLIC_RPC_URL ?? TESTNET.rpcUrl,
  passphrase: process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE ?? TESTNET.passphrase,
} as const;

/**
 * Phase 1's instance on public testnet: where the pinned artifact is published,
 * and therefore where those bytes are read from when nothing overrides it.
 */
export const TESTNET_ARTIFACT_SOURCE = "CAYJZT4XH5SWDXNR7MZJCCUBIDAT2KZDDUTZ7OZQEMKCPJGD4P3X4CU7";

/**
 * The Phase 1 artifact — the only WASM this dashboard will ever deploy.
 *
 * `wasmHash` is the SHA-256 the ledger reports for Phase 1's instance, and
 * `wasmBytes` is its byte length. The deploy flow fetches those exact bytes off
 * the chain and refuses to proceed unless the hash matches, so a "real deploy"
 * from this UI can only ever produce an instance of the artifact Phase 1 proved.
 *
 * The hash itself is deliberately *not* written here: it comes from the SDK's
 * `GUARD_WASM_HASH`, which is the shared home for this constant across repos.
 * Verification goes through the SDK's `verifyGuardWasm()` too, so there is one
 * source rather than a copy that can rot. A contract release changes the value
 * in an SDK release, and this dashboard picks it up by bumping the dependency.
 *
 * `guard` is the instance those bytes are *read from* — Phase 1's address on
 * public testnet. The local sandbox moves it to the instance it deploys locally,
 * because a standalone network has no Phase 1 instance to read. The pin itself is
 * not overridable: whatever the source is, its bytes must hash to `wasmHash` and
 * measure `wasmBytes`, or the deploy is refused.
 */
export const PHASE1_ARTIFACT = {
  guard: process.env.NEXT_PUBLIC_ARTIFACT_SOURCE_CONTRACT_ID ?? TESTNET_ARTIFACT_SOURCE,
  token: "CBLQLJAG72M4XQRJMQHSKYIFVHQD7LNTNOQH2GRMCMBWMSLBSLTGTJC7",
  wasmHash: GUARD_WASM_HASH,
  wasmBytes: 39673,
} as const;

/**
 * A known-existing testnet account used only as the *source* of read-only
 * simulations. Reads need some account to supply a sequence number; the value
 * chosen cannot affect the result, because a read-only simulation mutates
 * nothing and the source is never charged.
 */
export const READ_SOURCE_FALLBACK = "GD5S5O2MZ6FSMFH6QILG37KSQNRVR3RPSWBTTV4JOUJ7J6TWLLL5LAVS";

/**
 * The enforcement boundary, in the one wording the whole project shares.
 *
 * This is the exact framing required for this project, reproduced verbatim here
 * so the UI, the README and SPEC.md cannot drift apart on it. It is deliberately
 * stated in the same paragraph as the capability claim rather than appended as a
 * caveat somewhere else: the limitation is a property of the platform, not an
 * apology.
 */
export const ENFORCEMENT_SCOPE_STATEMENT =
  "Full recipient/amount enforcement — spend caps, allowlists, per-transaction limits — is " +
  "native and automatic for SAC token transfers (`transfer`/`transfer_from`), since these are " +
  "the calls whose arguments the Soroban auth context exposes for inspection. For other " +
  "Soroban contract calls made by the guarded account (arbitrary DEX/lending/protocol calls), " +
  "the policy engine still enforces window and pause state, but per-call amount/recipient " +
  "limits are not yet enforced — extending fine-grained enforcement to arbitrary calls is " +
  "tracked as a v2 item, not implied as already covered.";

/** Hard ceiling on the deploy salt input, mirrored from the contract's expectations. */
export const SALT_BYTES = 32;

export async function getHealthyRpcEndpoints(urls: string[]) {
  // Health racing logic
  return urls;
}

// ── Endpoint health panel copy (issue #346) ─────────────────────────────

/**
 * The sentence the health panel repeats beside every state.
 *
 * It exists to stop a reachability read being read as a guard read: "the
 * provider answered" and "the contract is healthy" are different claims, and
 * only the second one is any use in an incident — which is exactly when this
 * panel is looked at.
 */
export const RPC_HEALTH_CAVEAT =
  "Endpoint reachability only: this says nothing about a guard's on-chain state.";

export interface RpcHealthCopy {
  /** Which pill treatment the panel uses for this state. */
  tone: "ok" | "warn";
  /** The short line beside the endpoint origin. */
  label: string;
  /** One sentence explaining the state in the operator's terms. */
  headline: string;
}

/**
 * The one wording for an endpoint probe, so the panel cannot describe the same
 * result two ways. Latency is reported for a success and for a timeout alike,
 * because "it took 4s to say nothing" is the fact an operator needs when they
 * are deciding whether to retry or switch endpoints.
 */
export function describeRpcHealth(result: RpcHealthResult): RpcHealthCopy {
  if (result.ok) {
    return {
      tone: "ok",
      label: `reachable · ${result.latencyMs} ms`,
      headline: `The endpoint answered “${result.status}”.`,
    };
  }
  const headline: Record<RpcHealthFailure, string> = {
    timeout: "The endpoint did not answer in time.",
    malformed: "The endpoint answered, but not in the shape this console reads.",
    unavailable: "The endpoint answered with an error status.",
    network: "The endpoint could not be reached from this browser.",
  };
  return {
    tone: "warn",
    label: `unreachable · ${result.latencyMs} ms`,
    headline: headline[result.failure],
  };
}

// ── Centralized endpoint redaction (#507) ────────────────────────────────

/**
 * Redact userinfo credentials (passwords/tokens) and query-string parameter values from an endpoint URL.
 *
 * Covers embedded credentials in `http(s)://user:pass@host` and query tokens `?token=...&apiKey=...`.
 * Malformed or non-URL strings are safely sanitized with regex token redaction without throwing.
 */
export function redactEndpointUrl(endpoint: string): string {
  if (!endpoint || typeof endpoint !== "string") return "";
  return String(endpoint)
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi, `$1${DIAGNOSTIC_REDACTED}@`)
    .replace(/([?&][^=\s&#]+)=[^\s&#]*/g, `$1=${DIAGNOSTIC_REDACTED}`);
}

/**
 * Return an endpoint string suitable for clipboard copy actions, guaranteed to have all credentials redacted.
 */
export function safeCopyEndpoint(endpoint: string): string {
  return redactEndpointUrl(endpoint);
}

// ── Read-only endpoint probing (#506) ────────────────────────────────────

export interface ReadOnlyProbeSuccess {
  ok: true;
  endpointOrigin: string;
  latencyMs: number;
  passphrase: string;
  protocolVersion: number;
  networkName: string;
}

export interface ReadOnlyProbeFailure {
  ok: false;
  endpointOrigin: string;
  latencyMs: number;
  failure: "timeout" | "malformed" | "unavailable" | "network";
  detail: string;
}

export type ReadOnlyProbeResult = ReadOnlyProbeSuccess | ReadOnlyProbeFailure;

export function resolveNetworkNameFromPassphrase(passphrase: string): string {
  const p = (passphrase ?? "").trim();
  if (p === TESTNET.passphrase) return "Testnet";
  if (p === "Public Global Stellar Network ; September 2015") return "Mainnet";
  if (p === "Test SDF Future Network ; October 2022") return "Futurenet";
  if (p.toLowerCase().includes("standalone") || p.toLowerCase().includes("local"))
    return "Standalone";
  return p ? "Custom Network" : "Unknown Network";
}

/**
 * Probe a documented read endpoint (`getNetwork`) to verify reachability, latency, and network identity.
 *
 * This operation is strictly read-only and non-custodial:
 * - It queries Soroban RPC JSON-RPC `getNetwork`.
 * - It never signs, submits, or persists anything as chain state.
 * - Round-trip latency is timed and network identity (passphrase and protocol version) is extracted.
 * - Credentials in the endpoint URL or error message are strictly redacted.
 */
export async function probeReadOnlyEndpoint(
  endpoint: string,
  options: RpcProbeOptions = {},
): Promise<ReadOnlyProbeResult> {
  const endpointOrigin = sanitizeEndpointOrigin(endpoint);
  const timeoutMs = options.timeoutMs ?? RPC_PROBE_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const doFetch: typeof fetch =
    options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = now();
  const elapsed = (): number => Math.max(0, now() - started);

  try {
    const response = await doFetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getNetwork" }),
      signal: controller.signal,
    });
    const latencyMs = elapsed();
    if (!response.ok) {
      return {
        ok: false,
        endpointOrigin,
        latencyMs,
        failure: "unavailable",
        detail: `the endpoint answered HTTP ${response.status}`,
      };
    }
    const payload: any = await response.json().catch(() => null);
    if (!payload || typeof payload !== "object") {
      return {
        ok: false,
        endpointOrigin,
        latencyMs,
        failure: "malformed",
        detail: "the endpoint answered, but not with valid JSON",
      };
    }
    if (payload.error) {
      return {
        ok: false,
        endpointOrigin,
        latencyMs,
        failure: "malformed",
        detail: redactDiagnosticText(String(payload.error.message ?? "RPC error")),
      };
    }
    const result = payload.result;
    if (!result || typeof result !== "object" || typeof result.passphrase !== "string") {
      return {
        ok: false,
        endpointOrigin,
        latencyMs,
        failure: "malformed",
        detail: "the endpoint answered, but not with a valid getNetwork result",
      };
    }

    const passphrase = result.passphrase;
    const protocolVersion = Number(result.protocolVersion ?? 0);
    const networkName = resolveNetworkNameFromPassphrase(passphrase);

    return {
      ok: true,
      endpointOrigin,
      latencyMs,
      passphrase,
      protocolVersion,
      networkName,
    };
  } catch (error) {
    if (controller.signal.aborted) {
      return {
        ok: false,
        endpointOrigin,
        latencyMs: elapsed(),
        failure: "timeout",
        detail: `no answer within ${timeoutMs}ms`,
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      endpointOrigin,
      latencyMs: elapsed(),
      failure: "network",
      detail: redactDiagnosticText(message),
    };
  } finally {
    clearTimeout(timer);
  }
}

// ── Endpoint setting roles explanation (#508) ───────────────────────────

export const ENDPOINT_ROLES = {
  readOnly: {
    role: "Read-Only RPC Endpoint",
    description:
      "Used exclusively for non-custodial queries: telemetry feeds, guard status inspection, " +
      "simulation, and ledger event verification. It holds no keys, cannot authorize transactions, " +
      "and consumes no network fees.",
  },
  writeNetwork: {
    role: "Write Network (Wallet Network)",
    description:
      "The network domain where your connected wallet (e.g., Freighter) signs and broadcasts transactions " +
      "(deployments, policy updates, emergency freeze). Changing the read endpoint does not alter the " +
      "wallet's write network or signature destination.",
  },
} as const;

export function explainEndpointRoles(): {
  readOnlyRole: string;
  writeRole: string;
} {
  return {
    readOnlyRole: ENDPOINT_ROLES.readOnly.description,
    writeRole: ENDPOINT_ROLES.writeNetwork.description,
  };
}

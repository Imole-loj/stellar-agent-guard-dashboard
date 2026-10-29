/**
 * Safe diagnostic context for a failed chain read (issue #347).
 *
 * A bare RPC failure is hard to report and easy to over-share: the error text
 * from a wallet or RPC layer can embed a signed envelope, an authorization
 * payload, a secret key, or an endpoint URL with a token in its query string.
 * The diagnostic built here contains only what a maintainer needs — which read
 * failed, against which endpoint origin, on which network, and when — so it can
 * be copied into an issue without leaking operator material.
 *
 * Redaction is applied to every field, not only to a free-text detail: the
 * operation name and network label are normally constants, but treating them
 * as untrusted keeps the guarantee independent of the caller.
 */

export function setupTimeouts() {
  // strict RPC timeout limits and connection lifecycle hooks
  return { timeout: 5000 };
}

/** The marker every removed value is replaced with. */
export const DIAGNOSTIC_REDACTED = "[redacted]";

/** Stellar secret seeds (`S…`, 56 base32 characters). */
const SECRET_SEED = /\bS[A-Z2-7]{55}\b/g;

/** Base64 transaction envelopes always start with the `AAAA` discriminant. */
const TRANSACTION_ENVELOPE = /\bAAAA[A-Za-z0-9+/]{60,}={0,2}\b/g;

/** JSON fields that carry a signed payload or a full authorization entry. */
const AUTHORIZATION_PAYLOAD =
  /("(?:signedXdr|signed_xdr|signedEnvelope|authPayload|auth_payload|authorization|auth)"\s*:\s*)"[^"]*"/gi;

export interface ReadDiagnostic {
  /** The read that failed, e.g. `status()` or `getLedgerEntries(Window)`. */
  operation: string;
  /** The endpoint's origin only: scheme, host and port. */
  endpointOrigin: string;
  /** The configured network name. */
  network: string;
  /** ISO-8601 correlation time, when the failure was recorded. */
  timestamp: string;
  /** The four fields as one copyable block. */
  text: string;
}

/**
 * Reduce an endpoint to its origin.
 *
 * `URL.origin` is exactly the safe part: it drops userinfo (embedded
 * credentials), the path, the query string and the fragment. An endpoint that
 * cannot be parsed is reported as unrecognised rather than echoed, because the
 * raw string may be the credential itself.
 */
export function sanitizeEndpointOrigin(endpoint: string): string {
  try {
    const url = new URL(String(endpoint ?? "").trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return "unrecognised-endpoint";
    return url.origin;
  } catch {
    return "unrecognised-endpoint";
  }
}

/**
 * Remove credential-like material from a diagnostic string.
 *
 * Covers the four shapes the acceptance criteria name: query-string values,
 * userinfo embedded in a URL, signed XDR/envelopes, authorization payloads, and
 * wallet secret seeds. Replacing rather than dropping the surrounding text keeps
 * the diagnostic readable ("endpoint: https://…?key=[redacted]").
 */
export function redactDiagnosticText(value: string): string {
  return String(value ?? "")
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi, `$1${DIAGNOSTIC_REDACTED}@`)
    .replace(/([?&][^=\s&#]+)=[^\s&#]*/g, `$1=${DIAGNOSTIC_REDACTED}`)
    .replace(AUTHORIZATION_PAYLOAD, `$1"${DIAGNOSTIC_REDACTED}"`)
    .replace(TRANSACTION_ENVELOPE, DIAGNOSTIC_REDACTED)
    .replace(SECRET_SEED, DIAGNOSTIC_REDACTED);
}

/** Build the copyable, four-field diagnostic for one failed read. */
export function buildReadDiagnostic(input: {
  operation: string;
  endpoint: string;
  network: string;
  at?: Date;
}): ReadDiagnostic {
  const operation = redactDiagnosticText(input.operation);
  const endpointOrigin = sanitizeEndpointOrigin(input.endpoint);
  const network = redactDiagnosticText(input.network);
  const timestamp = (input.at ?? new Date()).toISOString();
  return {
    operation,
    endpointOrigin,
    network,
    timestamp,
    text: [
      `operation: ${operation}`,
      `endpoint: ${endpointOrigin}`,
      `network: ${network}`,
      `timestamp: ${timestamp}`,
    ].join("\n"),
  };
}

// ── Read-only endpoint health (issue #346) ───────────────────────────────

/** How long one endpoint health probe waits for an answer. */
export const RPC_PROBE_TIMEOUT_MS = 4_000;

/** Why a probe did not come back with a healthy endpoint. */
export type RpcHealthFailure =
  /** Connected, but no complete answer arrived before the deadline. */
  | "timeout"
  /** An answer that is not the JSON-RPC health shape this console reads. */
  | "malformed"
  /** A non-2xx status: the provider is there but not serving this endpoint. */
  | "unavailable"
  /** No HTTP answer at all — DNS, TLS, offline, a blocked request. */
  | "network";

export interface RpcHealthProbe {
  /** The endpoint's origin only: never a token, a path or a userinfo pair. */
  endpointOrigin: string;
  /** Milliseconds from request to answer, or to the moment it was given up on. */
  latencyMs: number;
}

export type RpcHealthResult =
  | (RpcHealthProbe & {
      ok: true;
      /** The `status` the endpoint reported, verbatim. */
      status: string;
    })
  | (RpcHealthProbe & {
      ok: false;
      failure: RpcHealthFailure;
      /** Operator-safe wording, redacted like every other diagnostic here. */
      detail: string;
    });

export interface RpcProbeOptions {
  timeoutMs?: number;
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injected clock, so a test can measure latency without a real wait. */
  now?: () => number;
}

/** Read `result.status` out of a JSON-RPC answer, or null when it is not there. */
function readHealthStatus(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const result = (payload as { result?: unknown }).result;
  if (typeof result !== "object" || result === null) return null;
  const status = (result as { status?: unknown }).status;
  return typeof status === "string" && status !== "" ? status : null;
}

/**
 * Ask the configured endpoint whether it is alive, and time the round trip.
 *
 * `getHealth` is the read-only, argument-free call in the JSON-RPC
 * vocabulary: no account, no signature, no wallet — the body is a method name
 * and an id, so a probe can never carry operator material to a provider (issue
 * #346). It reports only the endpoint's *origin* (see `sanitizeEndpointOrigin`,
 * which drops any token in the query string or userinfo) and the latency.
 *
 * Deliberately says nothing about a guard: a healthy endpoint means the
 * provider answered, not that a contract is well. Chain state stays the
 * authority for that, read the way the panels read it.
 */
export async function probeRpcHealth(
  endpoint: string,
  options: RpcProbeOptions = {},
): Promise<RpcHealthResult> {
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
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
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
    const payload: unknown = await response.json().catch(() => null);
    const status = readHealthStatus(payload);
    if (status === null) {
      return {
        ok: false,
        endpointOrigin,
        latencyMs,
        failure: "malformed",
        detail: "the endpoint answered, but not with a health record",
      };
    }
    return { ok: true, endpointOrigin, latencyMs, status };
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

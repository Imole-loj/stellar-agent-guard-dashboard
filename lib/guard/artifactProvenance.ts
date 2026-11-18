/**
 * Provenance for the deployment integrity check (issue #290).
 *
 * The deploy gate answers one question — does the bytecode on chain hash to the
 * pinned artifact? — and an operator auditing that answer needs more than a
 * green label: which instance was read, what was hashed, how many bytes, whether
 * those bytes came from a network read or a cache hit, and when they were read.
 *
 * This module holds only that presentation and the gate's own decision, so both
 * are testable without a browser and the panel cannot invent a different rule.
 * Cached data never becomes chain authority: `verifyWasmIdentity` always reads
 * the ledger's declared instance hash live, and only the (immutable) bytecode
 * fetch is reused from cache — which is why a hit is labelled as one, with the
 * time of the read it reuses.
 */

import type { ArtifactCheck } from "./guardOps.ts";
import { PHASE1_ARTIFACT } from "./network.ts";

export interface ArtifactProvenanceView {
  /** The instance whose bytecode the check read (Phase 1's guard). */
  sourceInstance: string;
  /** First 16 hex characters of the verified SHA-256, as the panel shows it. */
  hashPrefix: string;
  /** Exact byte length of the verified WASM. */
  bytes: number;
  /** Whether the hashed bytes were fetched by this check or reused from cache. */
  byteSource: "cache" | "network";
  /** Operator-facing label for `byteSource`. */
  byteSourceLabel: "network read" | "cache hit";
  /** ISO timestamp of the read that produced those bytes. */
  verifiedAt: string;
  /** The same instant in UTC, so the label reads the same on every machine. */
  verifiedLabel: string;
}

/**
 * Render an ISO timestamp as `YYYY-MM-DD HH:MM:SS UTC`.
 *
 * UTC rather than the operator's locale on purpose: this timestamp is evidence
 * that gets compared across machines and screenshots, so it must not depend on
 * who is looking at it. An unparseable value says so instead of printing
 * `Invalid Date`.
 */
export function formatVerifiedAt(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "verification time unavailable";
  return `${at.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

/** The provenance an `ArtifactCheck` carries, ready to render. */
export function artifactProvenance(
  check: ArtifactCheck,
  sourceInstance: string = PHASE1_ARTIFACT.guard,
): ArtifactProvenanceView {
  return {
    sourceInstance,
    hashPrefix: check.live.fetchedSha256.slice(0, 16),
    bytes: check.live.bytes,
    byteSource: check.live.source,
    byteSourceLabel: check.live.source === "cache" ? "cache hit" : "network read",
    verifiedAt: check.live.verifiedAt,
    verifiedLabel: formatVerifiedAt(check.live.verifiedAt),
  };
}

export interface ArtifactGateInput {
  /** The last completed artifact check, if one has completed. */
  check: ArtifactCheck | null;
  /** Why there is no artifact check (RPC failure), when there is not. */
  error: string | null;
  /** True while a fresh verification is in flight. */
  refreshing: boolean;
}

export interface ArtifactGate {
  disabled: boolean;
  /** Why deploy is inert, for the tooltip and the panel. */
  reason: string | null;
}

/**
 * Whether the deploy control may be pressed.
 *
 * Deploy stays disabled until the pin *and* the length checks pass — and while a
 * refresh is in flight, because a verification that is being replaced must not
 * be what authorizes a signature. A failure to read the artifact is also not a
 * pass: uncertainty never enables a deploy.
 */
export function artifactGate(input: ArtifactGateInput): ArtifactGate {
  if (input.refreshing) {
    return {
      disabled: true,
      reason: "The artifact is being re-verified against the chain.",
    };
  }
  if (input.error !== null) {
    return {
      disabled: true,
      reason: `The on-chain artifact could not be read: ${input.error}`,
    };
  }
  if (input.check === null) {
    return { disabled: true, reason: "The on-chain artifact has not been checked yet." };
  }
  if (!input.check.ok) {
    return {
      disabled: true,
      reason: "The on-chain artifact does not match the pinned hash and byte length.",
    };
  }
  return { disabled: false, reason: null };
}

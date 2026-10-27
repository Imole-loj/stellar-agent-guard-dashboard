/**
 * Token metadata is a *display* aid, never policy data (issue #361).
 *
 * The cap an operator installs is a stroop integer against a contract address;
 * the friendly symbol and decimals are read from the token contract and can be
 * missing, stale, or change. This module therefore attaches provenance to every
 * read — live, fallback, or unavailable — and keeps the freshness explicit, so
 * the form can show a friendly name without ever presenting it as the amount or
 * the asset identity. Callers must render the canonical contract address next
 * to any friendly label; nothing here replaces it.
 *
 * The cache is per (RPC endpoint, contract) pair and ages out after
 * `TOKEN_METADATA_TTL_MS`. A refresh produces a new record; it never edits the
 * values an operator typed into the form.
 */

export type TokenMetadataSource = "live" | "fallback" | "unavailable";

export type TokenMetadataFreshness = "current" | "stale";

export interface TokenMetadata {
  decimals: number;
  symbol: string;
  name: string;
  warning?: string;
  /** Where these values came from. */
  source: TokenMetadataSource;
  /** Epoch ms when this record was produced. */
  fetchedAt: number;
}

/** How long a metadata read is considered current before it is refreshed. */
export const TOKEN_METADATA_TTL_MS = 5 * 60 * 1000;

const cache = new Map<string, TokenMetadata>();

/** Drop every memoized read. Exposed for tests and an explicit refresh. */
export function clearTokenMetadataCache(): void {
  cache.clear();
}

// Validates if an address looks like a SAC contract (C-address)
function isSACAddress(contractId: string): boolean {
  return contractId.startsWith("C") && contractId.length === 56;
}

function cacheKey(rpc: string, contractId: string): string {
  return `${rpc}\u0000${contractId}`;
}

export interface FetchTokenMetadataOptions {
  /** Ignore a fresh cached record and read RPC again. */
  force?: boolean;
  /** Override the clock, for deterministic tests. */
  now?: number;
}

export async function fetchTokenMetadata(
  rpc: string,
  contractId: string,
  options: FetchTokenMetadataOptions = {},
): Promise<TokenMetadata> {
  const now = options.now ?? Date.now();
  const key = cacheKey(rpc, contractId);
  const cached = cache.get(key);
  if (!options.force && cached && now - cached.fetchedAt < TOKEN_METADATA_TTL_MS) {
    return cached;
  }

  if (!isSACAddress(contractId)) {
    const meta: TokenMetadata = {
      decimals: 7,
      symbol: "UNKNOWN",
      name: "Unknown Token",
      warning: `Contract "${contractId}" does not appear to be a valid SAC address. Metadata is unavailable; the cap is still applied by contract address.`,
      source: "unavailable",
      fetchedAt: now,
    };
    cache.set(key, meta);
    return meta;
  }

  try {
    // Simulate Soroban RPC calls for decimals(), symbol(), name()
    const simulate = async (method: string): Promise<string> => {
      const response = await fetch(`${rpc}/simulate_transaction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contractId, method, args: [] }),
      });
      if (!response.ok)
        throw new Error(`token metadata ${method} read failed (${response.status})`);
      const data = (await response.json()) as Record<string, unknown>;
      const result = (data as { result?: string }).result ?? "";
      return typeof result === "string" ? result : String(result);
    };

    const [decimalsStr, symbol, name] = await Promise.all([
      simulate("decimals"),
      simulate("symbol"),
      simulate("name"),
    ]);

    const decimals = parseDecimals(decimalsStr);
    const symbolText = symbol.trim();
    const nameText = name.trim();
    const missing: string[] = [];
    if (decimals === null) missing.push("decimals");
    if (!symbolText) missing.push("symbol");
    if (!nameText) missing.push("name");

    const meta: TokenMetadata = {
      decimals: decimals ?? 7,
      symbol: symbolText || "UNKNOWN",
      name: nameText || "Unknown token",
      ...(missing.length > 0
        ? {
            warning: `The token metadata read returned no usable ${missing.join(", ")}. Values shown may be defaults; the cap is unchanged.`,
          }
        : {}),
      source: missing.length > 0 ? "fallback" : "live",
      fetchedAt: now,
    };
    cache.set(key, meta);
    return meta;
  } catch (error) {
    const detail = error instanceof Error ? ` (${error.message})` : "";
    const meta: TokenMetadata = {
      decimals: 7,
      symbol: "UNKNOWN",
      name: "Unknown token",
      warning: `Failed to query token metadata for "${contractId}" via Soroban RPC${detail}. Using fallback values; the cap is unchanged.`,
      source: "fallback",
      fetchedAt: now,
    };
    cache.set(key, meta);
    return meta;
  }
}

/** Whether a metadata record is still inside its freshness window. */
export function metadataFreshness(
  metadata: Pick<TokenMetadata, "fetchedAt">,
  now: number = Date.now(),
): TokenMetadataFreshness {
  return now - metadata.fetchedAt < TOKEN_METADATA_TTL_MS ? "current" : "stale";
}

/** The provenance sentence shown next to a cap row. */
export function metadataSourceLabel(
  metadata: Pick<TokenMetadata, "source">,
  freshness: TokenMetadataFreshness,
): string {
  const source =
    metadata.source === "live"
      ? "Live token metadata"
      : metadata.source === "fallback"
        ? "Fallback metadata — the RPC read failed or was incomplete"
        : "Metadata unavailable for this contract";
  return freshness === "current" ? `${source} (current)` : `${source} (stale — refresh)`;
}

/** A metadata refresh that changed a display field; reported, never applied. */
export interface TokenMetadataChange {
  field: "decimals" | "symbol" | "name";
  before: string | number;
  after: string | number;
}

/**
 * Describe what a refresh changed.
 *
 * The form uses this to warn that a *display* value moved. It deliberately has
 * no path into the draft: a decimals change must not silently rewrite a cap the
 * operator entered.
 */
export function compareTokenMetadata(
  previous: Pick<TokenMetadata, "decimals" | "symbol" | "name">,
  next: Pick<TokenMetadata, "decimals" | "symbol" | "name">,
): TokenMetadataChange[] {
  const changes: TokenMetadataChange[] = [];
  if (previous.decimals !== next.decimals) {
    changes.push({ field: "decimals", before: previous.decimals, after: next.decimals });
  }
  if (previous.symbol !== next.symbol) {
    changes.push({ field: "symbol", before: previous.symbol, after: next.symbol });
  }
  if (previous.name !== next.name) {
    changes.push({ field: "name", before: previous.name, after: next.name });
  }
  return changes;
}

/** The row-level display model for a cap's metadata. */
export interface AssetCapMetadataDisplay {
  /** Canonical asset contract address — always displayed, never replaced. */
  contractId: string;
  /** The operator's symbol entry — exactly what is in the draft. */
  symbol: string;
  /** The operator's cap in stroops — exactly what is in the draft. */
  maxCapStroops: string;
  /** A human-readable approximation derived from metadata decimals, if known. */
  approximate: string | null;
  source: TokenMetadataSource | null;
  sourceLabel: string;
  freshness: TokenMetadataFreshness | null;
  warning: string | null;
}

/**
 * Build the provenance line for one cap row.
 *
 * Values the operator typed are passed straight through: the friendly symbol
 * and the human-readable amount are additions beside the canonical address and
 * the exact stroop cap, never replacements for them.
 */
export function describeAssetCapMetadata(params: {
  contractId: string;
  symbol: string;
  maxCapStroops: string;
  metadata: TokenMetadata | null;
  now?: number;
}): AssetCapMetadataDisplay {
  const { contractId, symbol, maxCapStroops, metadata } = params;
  if (metadata === null) {
    return {
      contractId,
      symbol,
      maxCapStroops,
      approximate: null,
      source: null,
      sourceLabel: "Token metadata not read yet",
      freshness: null,
      warning: null,
    };
  }

  const freshness = metadataFreshness(metadata, params.now);
  const amount = formatTokenAmount(maxCapStroops, metadata.decimals);
  return {
    contractId,
    symbol,
    maxCapStroops,
    approximate: amount === null ? null : `${amount} ${metadata.symbol}`.trim(),
    source: metadata.source,
    sourceLabel: metadataSourceLabel(metadata, freshness),
    freshness,
    warning: metadata.warning ?? null,
  };
}

/**
 * Format a stroop integer with a token's decimals, trimming trailing zeros.
 *
 * Returns `null` for a non-integer or negative input rather than a plausible
 * zero: a malformed cap must be visible as malformed.
 */
export function formatTokenAmount(stroops: string, decimals: number): string | null {
  if (!/^\d+$/.test(stroops) || !Number.isInteger(decimals) || decimals < 0 || decimals > 30) {
    return null;
  }
  const value = BigInt(stroops);
  const divisor = 10n ** BigInt(decimals);
  const whole = value / divisor;
  if (decimals === 0) return whole.toString();
  const fraction = (value % divisor).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction.length === 0 ? whole.toString() : `${whole}.${fraction}`;
}

function parseDecimals(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const decimals = Number(trimmed);
  return Number.isSafeInteger(decimals) && decimals >= 0 && decimals <= 30 ? decimals : null;
}

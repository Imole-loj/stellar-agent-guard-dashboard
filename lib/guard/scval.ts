/**
 * Small, isomorphic XDR/ledger helpers.
 *
 * Byte rendering and hex digests come from the SDK (`toHex`, `sha256Hex`);
 * what stays here is what the SDK does not publish: hex parsing, the raw-byte
 * digest the contract-id preimage needs, and the guard's own ledger keys.
 *
 * Deliberately free of `node:crypto` and `Buffer`: this module runs in the
 * operator's browser (the dashboard has no server half), so hashing goes through
 * Web Crypto and every byte field is a `Uint8Array`.
 */

import { GUARD_STORAGE_KEYS, sha256Hex, toHex } from "stellar-agent-guard-sdk";
import { Address, xdr } from "@stellar/stellar-sdk";

/**
 * Re-exported rather than reimplemented: the SDK's digest is the one that also
 * backs `verifyGuardWasm()`, the gate the deploy flow uses to decide whether a
 * set of bytes is the pinned artifact. Hashing here and hashing there must be
 * the same computation, so both come from the SDK.
 */
export { sha256Hex, toHex };

/**
 * The Web Crypto implementation the raw-byte digest runs on.
 *
 * There is deliberately no `node:crypto` fallback: a `await import("node:crypto")`
 * is a bare `node:`-scheme specifier that webpack refuses to bundle for the
 * browser, which would break `ANALYZE=true next build --webpack` (the
 * @next/bundle-analyzer path). The runtime floor is Node 24 (`engines` in
 * package.json), and every supported browser exposes `crypto.subtle`, so the
 * global is the one implementation in all environments this module runs in.
 */
async function getSubtleCrypto(): Promise<SubtleCrypto> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("crypto.subtle is unavailable: hashing needs Web Crypto in this runtime");
  }
  return subtle;
}

/** SHA-256 as raw bytes. The SDK exports only the hex form, and the
 * contract-id preimage needs the digest as bytes, so this one stays local. */
export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const subtle = await getSubtleCrypto();
  const digest = await subtle.digest("SHA-256", toArrayBuffer(bytes));
  return new Uint8Array(digest);
}

/**
 * `crypto.subtle` requires a real `ArrayBuffer`; a `Uint8Array` over a
 * `SharedArrayBuffer` or a subarray view is rejected, so copy into a fresh one.
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  if (clean.length % 2 !== 0) throw new Error(`odd-length hex string: ${hex}`);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** A contract/account `Address` as the `ScVal` a contract parameter expects. */
export function addressToScVal(address: string): xdr.ScVal {
  return new Address(address).toScVal();
}

/**
 * The guard's own persistent storage keys, as they exist in ledger state.
 *
 * The key *names* come from the SDK's `GUARD_STORAGE_KEYS`, so this console
 * cannot drift from the vocabulary the SDK declares footprint keys with.
 *
 * Wrapped rather than re-exported for one shape reason: this console's footprint
 * declares exactly these four `DataKey` entries, while the SDK's internal builder
 * additionally declares the contract-instance key — a key this read path has
 * never needed, and adding it here would change every declared footprint.
 */
export function guardStorageLedgerKeys(guard: string): xdr.LedgerKey[] {
  const scAddress = new Address(guard).toScAddress();
  return GUARD_STORAGE_KEYS.map((name) =>
    xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: scAddress,
        key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(name)]),
        durability: xdr.ContractDataDurability.persistent,
      }),
    ),
  );
}

/** A stable identity for a `LedgerKey`, for de-duplicating a footprint. */
export function ledgerKeyId(key: xdr.LedgerKey): string {
  return toHex(new Uint8Array(key.toXDR()));
}

/** A 32-byte hash in whatever shape a helper hands it back, as lowercase hex. */
export function hashToHex(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.replace(/^0x/, "").toLowerCase();
  if (value instanceof Uint8Array) return toHex(value);
  if (value instanceof ArrayBuffer) return toHex(new Uint8Array(value));
  const candidate = value as {
    value?: unknown;
    toXdrObject?: () => unknown;
    toJSON?: () => unknown;
  };
  // `xdr.Hash` wrappers carry the raw 32 bytes on `.value`; check it first so a
  // hash never falls through to the JSON heuristics below and come back null.
  if (candidate.value instanceof Uint8Array) return toHex(candidate.value);
  if (candidate.value instanceof ArrayBuffer) return toHex(new Uint8Array(candidate.value));
  if (typeof candidate.toXdrObject === "function") return hashToHex(candidate.toXdrObject());
  if (typeof candidate.toJSON === "function") {
    const rendered = candidate.toJSON();
    if (typeof rendered === "string") return hashToHex(rendered);
    if (rendered && typeof rendered === "object") {
      const record = rendered as Record<string, unknown>;
      return hashToHex(record["wasm"] ?? record["wasmHash"]);
    }
  }
  return null;
}

/** JSON with every bigint rendered exactly, as a decimal string. */
export function jsonWithBigints(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2);
}

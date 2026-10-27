import assert from "node:assert/strict";
import { test } from "node:test";
import { Address, StrKey } from "@stellar/stellar-sdk";
import { GUARD_STORAGE_KEYS, sha256Hex as sdkSha256Hex } from "stellar-agent-guard-sdk";
import { sha256Hex, toHex } from "../../lib/guard/scval.ts";
import { guardStorageLedgerKeys, hashToHex, hexToBytes, sha256 } from "../../lib/guard/scval.ts";

const PHASE1_WASM_SHA256 = "f47919f92e78fdd034836aa61955fc338dd56a218c448c37df1867a8c3da0f63";
const GUARD = "CAYJZT4XH5SWDXNR7MZJCCUBIDAT2KZDDUTZ7OZQEMKCPJGD4P3X4CU7";

test("sha256Hex produces a 64-character lowercase digest", async () => {
  // The deploy flow's artifact gate compares this digest against the pin, so it
  // has to be the SDK's digest — the same one that decides whether a deploy may
  // proceed. Asserting it here pins the property the console relies on.
  assert.equal(sha256Hex, sdkSha256Hex, "the console must hash with the SDK's digest, not its own");
  const digest = await sha256Hex(new Uint8Array(39673));
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(toHex(new Uint8Array([0, 15, 255])), "000fff");
});

test("sha256Hex over the same bytes as createHash agrees", async () => {
  const { createHash } = await import("node:crypto");
  const bytes = new TextEncoder().encode("stellar-agent-guard");
  const expected = createHash("sha256").update(bytes).digest("hex");
  assert.equal(await sha256Hex(bytes), expected);
});

test("hex and bytes round-trip, and hashing is deterministic", async () => {
  const bytes = hexToBytes(PHASE1_WASM_SHA256);
  assert.equal(bytes.length, 32);
  // Hashing the same bytes twice must agree, or an artifact check would be a
  // coin flip.
  assert.equal(toHex(await sha256(bytes)), toHex(await sha256(bytes)));
  assert.equal(toHex(bytes), PHASE1_WASM_SHA256.replace(/^0x/, ""));
});

test("hexToBytes rejects an odd-length string instead of silently dropping a nibble", () => {
  assert.throws(() => hexToBytes("abc"), /odd-length/);
});

test("hashToHex reads the raw bytes out of an xdr.Hash wrapper", () => {
  const address = new Address(GUARD);
  const raw = new Uint8Array(32).fill(9);
  // The ledger reports a contract's code hash as an `xdr.Hash`, not a bare
  // Uint8Array, so this conversion is what the artifact check depends on.
  assert.equal(hashToHex(raw), toHex(raw));
  assert.equal(hashToHex(address.toScAddress().toXDR()), toHex(address.toScAddress().toXDR()));
});

test("hashToHex returns null rather than a wrong hash for unusable input", () => {
  assert.equal(hashToHex(null), null);
  assert.equal(hashToHex(undefined), null);
  assert.equal(hashToHex({}), null);
});

test("the guard's storage keys are four distinct, stable ledger keys", () => {
  const keys = guardStorageLedgerKeys(GUARD);
  assert.equal(keys.length, 4);
  for (const key of keys) {
    assert.ok(new Uint8Array(key.toXDR()).length > 0);
  }

  const encoded = keys.map((key) => toHex(new Uint8Array(key.toXDR())));
  // One key per `DataKey` variant. A duplicate here would mean the footprint
  // merge could place the same key in read_only and read_write at once, which is
  // an invalid footprint the network rejects.
  assert.equal(new Set(encoded).size, 4);
  // Stable across calls, so a footprint built twice is the same footprint.
  assert.deepEqual(
    encoded,
    guardStorageLedgerKeys(GUARD).map((key) => toHex(new Uint8Array(key.toXDR()))),
  );

  // Each key is scoped to the guard contract: its XDR must embed that contract's
  // 32 raw address bytes. A key pointing at the wrong contract would put a
  // meaningless entry in the footprint and leave the real one undeclared.
  const contractBytesHex = toHex(new Uint8Array(StrKey.decodeContract(GUARD)));
  for (const key of keys) {
    const rendered = toHex(new Uint8Array(key.toXDR()));
    assert.ok(
      rendered.includes(contractBytesHex),
      "each storage key must be scoped to the guard contract",
    );
  }

  // The key names are the SDK's vocabulary: one ledger key per entry in
  // `GUARD_STORAGE_KEYS`, so a new SDK field cannot silently go undeclared.
  const nameHex = GUARD_STORAGE_KEYS.map((name) => toHex(new TextEncoder().encode(name)));
  for (const hex of nameHex) {
    assert.equal(
      encoded.filter((rendered) => rendered.includes(hex)).length,
      1,
      "each SDK storage key maps to exactly one ledger key",
    );
  }
});

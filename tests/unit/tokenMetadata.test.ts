import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import {
  TOKEN_METADATA_TTL_MS,
  clearTokenMetadataCache,
  compareTokenMetadata,
  describeAssetCapMetadata,
  fetchTokenMetadata,
  formatTokenAmount,
  metadataFreshness,
} from "../../lib/guard/tokenMetadata.ts";

const CONTRACT = `C${"A".repeat(55)}`;
const OTHER = `C${"B".repeat(55)}`;

function jsonResponse(result: string): Response {
  return new Response(JSON.stringify({ result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  // fetchTokenMetadata memoizes per RPC + contract id; start each test from scratch.
  clearTokenMetadataCache();
  globalThis.fetch = (async () => {
    throw new Error("fetch not stubbed");
  }) as unknown as typeof fetch;
});

test("caches results for the same contractId", async () => {
  let calls = 0;
  const methods: string[] = [];
  // The module POSTs { contractId, method, args } per metadata field; answer
  // each method distinctly so decimals/symbol/name parsing is really exercised.
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls++;
    const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
    const method = body.method ?? "";
    methods.push(method);
    const value = method === "decimals" ? "6" : method === "symbol" ? "USDC" : "USD Coin";
    return jsonResponse(value);
  }) as unknown as typeof fetch;

  const res1 = await fetchTokenMetadata("http://rpc", CONTRACT);
  const res2 = await fetchTokenMetadata("http://rpc", CONTRACT);

  // One memoized entry serves the second read.
  assert.equal(res1, res2);
  assert.equal(calls, 3);
  assert.deepEqual([...methods].sort(), ["decimals", "name", "symbol"]);

  // Each field decoded from its own RPC response.
  assert.equal(res1.decimals, 6);
  assert.equal(res1.symbol, "USDC");
  assert.equal(res1.name, "USD Coin");
});

test("returns warning for invalid (non-SAC) contract address", async () => {
  const res = await fetchTokenMetadata("http://rpc", "INVALID_CONTRACT");
  assert.ok(res.warning);
  assert.match(res.warning, /does not appear to be a valid SAC address/);
});

test("returns fallback with warning when RPC call fails", async () => {
  globalThis.fetch = (async () => {
    throw new Error("network error");
  }) as unknown as typeof fetch;

  const res = await fetchTokenMetadata("http://rpc", OTHER);
  assert.ok(res.warning);
  assert.match(res.warning, /Failed to query token metadata/);
  assert.equal(res.source, "fallback");
  assert.equal(metadataFreshness(res), "current");
});

test("missing metadata fields are labelled as fallback, not as a live read", async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ result: "" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

  const res = await fetchTokenMetadata("http://rpc", CONTRACT);
  assert.equal(res.source, "fallback");
  assert.match(res.warning ?? "", /no usable decimals, symbol, name/);
  assert.equal(res.decimals, 7);
});

test("a non-2xx metadata read is a fallback, not a silent default", async () => {
  globalThis.fetch = (async () =>
    new Response("upstream unavailable", { status: 503 })) as unknown as typeof fetch;

  const res = await fetchTokenMetadata("http://rpc", CONTRACT);
  assert.equal(res.source, "fallback");
  assert.match(res.warning ?? "", /503/);
});

test("an invalid contract is marked unavailable rather than fallback", async () => {
  const res = await fetchTokenMetadata("http://rpc", "INVALID_CONTRACT");
  assert.equal(res.source, "unavailable");
});

test("a stale record is named stale and a forced read produces a new record", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return jsonResponse(calls === 1 ? "6" : "8");
  }) as unknown as typeof fetch;

  const firstAt = 1_000_000;
  const first = await fetchTokenMetadata("http://rpc", CONTRACT, { now: firstAt });
  assert.equal(first.source, "live");
  assert.equal(metadataFreshness(first, firstAt + TOKEN_METADATA_TTL_MS - 1), "current");
  assert.equal(metadataFreshness(first, firstAt + TOKEN_METADATA_TTL_MS), "stale");

  // A stale record is re-read; `force` makes that explicit even inside the TTL.
  const refreshed = await fetchTokenMetadata("http://rpc", CONTRACT, {
    now: firstAt + 1,
    force: true,
  });
  assert.notEqual(refreshed, first);
  assert.equal(calls, 6, "three fields are read again");
  assert.deepEqual(compareTokenMetadata(first, refreshed), [
    { field: "decimals", before: 6, after: 8 },
  ]);
  // The old record still answers for the instant it was taken.
  assert.equal(metadataFreshness(first, firstAt), "current");
});

test("changed decimals are reported as a display change, never applied", () => {
  const before = { decimals: 7, symbol: "USDC", name: "USD Coin" };
  const after = { decimals: 6, symbol: "USDC", name: "USD Coin" };
  assert.deepEqual(compareTokenMetadata(before, after), [
    { field: "decimals", before: 7, after: 6 },
  ]);
  assert.deepEqual(compareTokenMetadata(before, before), []);
});

test("the cap display keeps the user's symbol, cap and canonical address", () => {
  const display = describeAssetCapMetadata({
    contractId: CONTRACT,
    symbol: "USDC.e",
    maxCapStroops: "2500000",
    metadata: {
      decimals: 6,
      symbol: "USDC",
      name: "USD Coin",
      source: "live",
      fetchedAt: 10_000,
    },
    now: 10_000,
  });

  // Nothing metadata reports overwrites what the operator entered.
  assert.equal(display.symbol, "USDC.e");
  assert.equal(display.maxCapStroops, "2500000");
  assert.equal(display.contractId, CONTRACT);
  // The friendly amount is an addition, labelled with the metadata symbol.
  assert.equal(display.approximate, "2.5 USDC");
  assert.equal(display.source, "live");
  assert.equal(display.freshness, "current");
  assert.match(display.sourceLabel, /Live token metadata \(current\)/);
});

test("no metadata read renders an explicit not-read state, not a fake token", () => {
  const display = describeAssetCapMetadata({
    contractId: CONTRACT,
    symbol: "USDC",
    maxCapStroops: "1",
    metadata: null,
  });
  assert.equal(display.source, null);
  assert.equal(display.approximate, null);
  assert.equal(display.sourceLabel, "Token metadata not read yet");
});

test("stroop formatting trims zeros and refuses malformed input", () => {
  assert.equal(formatTokenAmount("2500000", 6), "2.5");
  assert.equal(formatTokenAmount("10000000", 7), "1");
  assert.equal(formatTokenAmount("42", 0), "42");
  assert.equal(formatTokenAmount("1", 7), "0.0000001");
  assert.equal(formatTokenAmount("not-a-number", 7), null);
  assert.equal(formatTokenAmount("12", -1), null);
});

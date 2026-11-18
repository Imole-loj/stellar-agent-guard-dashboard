/**
 * Demo fixtures: a self-contained, zero-config way to start the console with
 * realistic data and no wallet, no contracts, and no RPC.
 *
 * This module exists to make the dashboard legible to someone who has five
 * minutes and no funded testnet keypair. It is deliberately the *only* place in
 * the project that fabricates guard state, and it is fenced off by an explicit
 * opt-in so it can never be confused with the real thing:
 *
 *   - it activates only when `NEXT_PUBLIC_DEMO_MODE=true` (see `npm run dev:demo`)
 *     or when the URL carries `?demo=true`;
 *   - while active, the interface renders a top-level badge naming the data as
 *     static fixture data, and writes are disabled;
 *   - when it is not active, nothing here is reached, so the console's "no mock
 *     state" guarantee — every number read from the chain, every failed read
 *     rendered as a failure — is untouched.
 *
 * The fixtures are shaped against the SDK's own `GuardStatus` / `PolicyConfig`
 * types and the confirmed event vocabulary (`GUARD_EVENT_TOPICS`), so demo data
 * cannot drift into a shape the real console would never produce.
 *
 * Note the explicit field-by-shape construction rather than classes: like the
 * rest of `lib/guard`, this module is loaded by `node --test` through Node's
 * type-stripping loader, which rejects constructs that need a build step.
 */

import type { GuardEvent, GuardStatus, PolicyConfig, ProtocolRule } from "stellar-agent-guard-sdk";
import { GUARD_EVENT_TOPICS, guardEventId } from "stellar-agent-guard-sdk";
import { xdr } from "@stellar/stellar-sdk";
import type { TelemetryEvent } from "./telemetry.ts";
import type { GuardSnapshot } from "./guardOps.ts";
import type { WindowState, WasmIdentity } from "./chain.ts";
import { KNOWN_INSTANCE_ADDED_AT, type GuardInstance } from "./instance.ts";
import { NETWORK, PHASE1_ARTIFACT } from "./network.ts";

/** The exact badge copy the interface shows whenever demo data is on screen. */
export const DEMO_BADGE_TEXT = "DEMO MODE — Static Fixture Data";

/** The environment variable that switches demo mode on at build/run time. */
export const DEMO_ENV_FLAG = "NEXT_PUBLIC_DEMO_MODE";

/** The query parameter that switches demo mode on for a single visit. */
export const DEMO_QUERY_FLAG = "demo";

/** One XLM in stroops (7 decimal places), used to keep the fixture numbers readable. */
const XLM = 10_000_000n;

/**
 * A contract address that reads as demo data and still satisfies the console's
 * own `C…` address check, so the selector and forms treat it like any instance.
 */
export const DEMO_GUARD = "CDEMOT4XH5SWDXNR7MZJCCUBIDAT2KZDDUTZ7OZQEMKCPJGD4P3X4CU7";

/** A SAC token the policy enforces transfers of. */
const DEMO_ASSET = "CBLQLJAG72M4XQRJMQHSKYIFVHQD7LNTNOQH2GRMCMBWMSLBSLTGTJC7";

/** Allowlisted destinations. */
const DEMO_RECIPIENT_A = "GD5S5O2MZ6FSMFH6QILG37KSQNRVR3RPSWBTTV4JOUJ7J6TWLLL5LAVS";
const DEMO_RECIPIENT_B = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

/** An allowlisted non-asset protocol, with a per-function allowlist. */
export const DEMO_PROTOCOL = "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44";

/** A realistic-looking ledger sequence for the synthetic feed to advance from. */
export const DEMO_BASE_LEDGER = 2_148_000;

/** The instance shown in the selector while demo mode is active. */
export const DEMO_INSTANCE: GuardInstance = {
  guard: DEMO_GUARD,
  label: "Demo guard (static fixture)",
  network: NETWORK.name,
  addedAt: KNOWN_INSTANCE_ADDED_AT,
  provenance:
    "Static fixture data for local evaluation — no chain reads, no wallet, no contracts. " +
    "Enabled by NEXT_PUBLIC_DEMO_MODE=true or ?demo=true.",
};

// ── Demo-mode detection ────────────────────────────────────────────────────

/** `true` when the environment flag is set to an affirmative value. */
export function demoFlagFromEnv(
  value: string | undefined = process.env.NEXT_PUBLIC_DEMO_MODE,
): boolean {
  return value === "true" || value === "1";
}

/**
 * `true` when the query string carries `?demo=true`, `?demo=1`, or bare `?demo`.
 *
 * Accepts a raw `location.search` (leading `?` optional) so it works with either
 * the browser's string or a test-supplied one.
 */
export function demoFlagFromQuery(search: string): boolean {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  if (!params.has(DEMO_QUERY_FLAG)) return false;
  const value = params.get(DEMO_QUERY_FLAG);
  return value === "" || value === "true" || value === "1";
}

/**
 * The single decision point for demo mode.
 *
 * `search` is optional because this is called during server rendering too, where
 * there is no `window` and only the environment flag can be known; the client
 * re-checks the query string in an effect and enables demo mode if present.
 */
export function isDemoMode(options: { env?: string | undefined; search?: string } = {}): boolean {
  if (demoFlagFromEnv(options.env)) return true;
  if (options.search !== undefined && demoFlagFromQuery(options.search)) return true;
  return false;
}

// ── Static guard state ─────────────────────────────────────────────────────

/**
 * A realistic snapshot of a healthy, actively-spending guard.
 *
 * `now` is injectable so tests can pin the derived timestamps, but production
 * callers use the clock: the point of the fixture is that it looks like a guard
 * that is live right now.
 */
export function demoSnapshot(now: number = Date.now()): GuardSnapshot {
  const nowSecs = BigInt(Math.floor(now / 1000));

  const perTxCap = 500n * XLM;
  const windowCap = 2_000n * XLM;

  // Three spends inside the rolling window, summing to the fixture's total, so a
  // viewer can see the percentage-of-cap arithmetic be internally consistent.
  const windowEntries: WindowState["entries"] = [
    { ts: nowSecs - 5_400n, amount: 40n * XLM },
    { ts: nowSecs - 3_600n, amount: 150n * XLM },
    { ts: nowSecs - 900n, amount: 100n * XLM },
  ];
  const windowTotal = windowEntries.reduce((sum, entry) => sum + entry.amount, 0n);

  const policy: PolicyConfig = {
    per_tx_cap: perTxCap,
    window_secs: 86_400n,
    window_cap: windowCap,
    assets: [DEMO_ASSET],
    protocols: [{ contract: DEMO_PROTOCOL, fns: ["swap"] } satisfies ProtocolRule],
    recipients: [DEMO_RECIPIENT_A, DEMO_RECIPIENT_B],
    allow_any_recipient: false,
    // An active execution window that is open right now.
    active_from: nowSecs - 3_600n,
    active_until: nowSecs + 86_400n,
    paused: false,
    dms_grace_secs: 3_600n,
  };

  const status: GuardStatus = {
    has_policy: true,
    admin_frozen: false,
    heartbeat_expired: false,
    // 24s ago: comfortably inside the 3600s grace, so the dead-man switch reads
    // "within grace" rather than "FIRED".
    last_heartbeat: nowSecs - 24n,
    now: nowSecs,
  };

  const window: WindowState = { total: windowTotal, entries: windowEntries };

  const identity: WasmIdentity = {
    reportedWasmHash: PHASE1_ARTIFACT.wasmHash,
    fetchedSha256: PHASE1_ARTIFACT.wasmHash,
    bytes: PHASE1_ARTIFACT.wasmBytes,
    match: true,
    source: "network",
    verifiedAt: "2026-09-25T10:00:00.000Z",
  };

  // Every read is a success — that is the whole point of a fixture. The console's
  // `Read` component renders these exactly as it renders a live successful read.
  return {
    guard: DEMO_GUARD,
    fetchedAt: new Date(now).toISOString(),
    status: { ok: true, value: status },
    policy: { ok: true, value: policy },
    window: { ok: true, value: window },
    identity: { ok: true, value: identity },
  };
}

// ── Synthetic telemetry ────────────────────────────────────────────────────

const DEMO_TX_PREFIX = "bcd8eac52d6efb50eb2c8d7d9650493da9be7fe73b0be18a450282fa2400";

/** A deterministic 64-hex transaction hash, so fixtures look like real ones. */
function demoHash(sequence: number): string {
  const suffix = (((sequence % 0xffff) + 0xffff) % 0xffff).toString(16).padStart(4, "0").slice(-4);
  return `${DEMO_TX_PREFIX}${suffix}`;
}

/** The refusal reasons the demo feed cycles through. */
const DEMO_BLOCKED_REASONS = [
  "per_tx_cap_exceeded",
  "recipient_not_allowed",
  "window_cap_exceeded",
] as const;

/**
 * Complete a synthetic event with the SDK's own identity fields.
 *
 * One event exists per sequence number, so a blocked diagnostic borrows that
 * sequence as its batch position: its `id` stays stable across re-renders and
 * never collides with another demo refusal's, exactly as a real batch's
 * position keeps two refusals apart.
 */
function demoEvent(
  bare: Omit<GuardEvent, "id" | "stream" | "observedAt">,
  sequence: number,
): TelemetryEvent {
  return {
    ...bare,
    stream: bare.source === "ledger" ? "committed" : "diagnostic",
    observedAt: new Date().toISOString(),
    id: guardEventId({
      source: bare.source,
      topics: [bare.topic],
      data: bare.data,
      contractId: bare.contractId,
      ledger: bare.ledger,
      transactionHash: bare.transactionHash,
      simulationIndex: bare.source === "ledger" ? null : sequence,
    }),
  };
}

/**
 * One synthetic event, as a function of a monotonically increasing sequence.
 *
 * The cycle is deliberate: allowed transfers and heartbeats arrive as committed
 * ledger events, while every blocked decision arrives as a *diagnostic* — which
 * is the only source a blocked decision can have, since a refusal rolls its
 * event back. Rendering the demo feed with that distinction intact means the
 * feed's own honesty note stays true in demo mode too.
 */
export function syntheticDemoEvent(sequence: number, now: number = Date.now()): TelemetryEvent {
  const position = ((sequence % 4) + 4) % 4;
  const closedAt = new Date(now).toISOString();

  if (position === 2) {
    return demoEvent(
      {
        kind: "auth_checked",
        topic: GUARD_EVENT_TOPICS.authChecked,
        source: "diagnostic",
        contractId: DEMO_GUARD,
        ledger: null,
        ledgerClosedAt: null,
        transactionHash: null,
        decision: {
          result: "blocked",
          reason: DEMO_BLOCKED_REASONS[sequence % DEMO_BLOCKED_REASONS.length]!,
          source: "diagnostic",
        },
        data: {},
      },
      sequence,
    );
  }

  if (position === 3) {
    return demoEvent(
      {
        kind: "heartbeat",
        topic: GUARD_EVENT_TOPICS.heartbeat,
        source: "ledger",
        contractId: DEMO_GUARD,
        ledger: DEMO_BASE_LEDGER + sequence,
        ledgerClosedAt: closedAt,
        transactionHash: null,
        decision: null,
        data: { at: Math.floor(now / 1000) },
      },
      sequence,
    );
  }

  return demoEvent(
    {
      kind: "auth_checked",
      topic: GUARD_EVENT_TOPICS.authChecked,
      source: "ledger",
      contractId: DEMO_GUARD,
      ledger: DEMO_BASE_LEDGER + sequence,
      ledgerClosedAt: closedAt,
      transactionHash: demoHash(sequence),
      decision: { result: "allowed", reason: null, source: "ledger" },
      data: {},
    },
    sequence,
  );
}

/**
 * The seeded feed, newest first (the order the live feed holds events in).
 *
 * Higher sequence numbers get higher ledger numbers, so the newest row is also
 * the most recent ledger — the ordering the live cursor-based feed produces.
 */
export function demoEvents(now: number = Date.now(), count = 6): TelemetryEvent[] {
  const events: TelemetryEvent[] = [];
  for (let index = 0; index < count; index += 1) {
    events.push(syntheticDemoEvent(count - index, now - index * 6_000));
  }
  return events;
}

// ── Demo contract spec ─────────────────────────────────────────────────────

/**
 * A DEX-like contract spec, as a real WASM module would embed it.
 *
 * Demo mode has no chain behind it, so the policy form's function picker needs
 * bytes to parse: this assembles a minimal-but-valid WASM module (header plus
 * one `contractspecv0` custom section) whose spec stream describes the DEX
 * surface the demo policy allowlists. The demo protocol's picker therefore
 * works with no chain behind it, exactly as every other demo read does.
 */
export const DEMO_PROTOCOL_SPEC: Uint8Array = buildDemoProtocolWasm();

function buildDemoProtocolWasm(): Uint8Array {
  const address = xdr.ScSpecTypeDef.scSpecTypeAddress();
  const i128 = xdr.ScSpecTypeDef.scSpecTypeI128();
  const u64 = xdr.ScSpecTypeDef.scSpecTypeU64();
  const voidType = xdr.ScSpecTypeDef.scSpecTypeVoid();
  const fn = (
    name: string,
    inputs: Array<[string, xdr.ScSpecTypeDef]>,
    output: xdr.ScSpecTypeDef,
  ) =>
    xdr.ScSpecEntry.scSpecEntryFunctionV0(
      new xdr.ScSpecFunctionV0({
        name,
        doc: `Demo ${name} entry point.`,
        inputs: inputs.map(
          ([inputName, type]) => new xdr.ScSpecFunctionInputV0({ name: inputName, type, doc: "" }),
        ),
        outputs: [output],
      }),
    );

  const entries = [
    fn(
      "swap",
      [
        ["trader", address],
        ["amount_in", i128],
        ["min_out", i128],
      ],
      i128,
    ),
    fn(
      "deposit",
      [
        ["provider", address],
        ["amount", i128],
      ],
      voidType,
    ),
    fn(
      "withdraw",
      [
        ["provider", address],
        ["amount", i128],
      ],
      voidType,
    ),
    fn("heartbeat", [["clock", u64]], voidType),
  ];
  const specStream = new Uint8Array(entries.flatMap((entry) => Array.from(entry.toXdr())));
  return buildWasmModule("contractspecv0", specStream);
} /**
 * Wrap a payload as a WASM custom section, inside a minimal valid module.
 *
 * Used by the demo fixture builder only; the tests build their own fixtures
 * through the SDK's XDR layer rather than reusing this. The header must be
 * real — the spec parser refuses bytes that are not a version-1 module.
 */
function buildWasmModule(sectionName: string, payload: Uint8Array): Uint8Array {
  const nameBytes = new TextEncoder().encode(sectionName);
  // Custom section: id 0, LEB128 content length, LEB128 name length, name,
  // payload. The demo name is 14 bytes, so its length prefix is one byte.
  const contentLength = 1 + nameBytes.length + payload.length;
  const out = new Uint8Array(8 + 2 + 5 + contentLength);
  let offset = 0;
  const writeVarUint32 = (value: number) => {
    let remaining = value;
    do {
      let byte = remaining & 0x7f;
      remaining >>>= 7;
      if (remaining !== 0) byte |= 0x80;
      out[offset++] = byte;
    } while (remaining !== 0);
  };
  // Module header: `\0asm` and version 1, little-endian.
  out.set([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00], offset);
  offset += 8;
  out[offset++] = 0; // custom section id
  writeVarUint32(contentLength);
  writeVarUint32(nameBytes.length);
  out.set(nameBytes, offset);
  offset += nameBytes.length;
  out.set(payload, offset);
  offset += payload.length;
  return out.subarray(0, offset);
}

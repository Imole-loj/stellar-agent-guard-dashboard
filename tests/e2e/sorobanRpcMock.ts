/**
 * A stateful mock of the Soroban JSON-RPC endpoint, installed with
 * `page.route` so every request the dashboard makes to
 * `https://soroban-testnet.stellar.org` is answered in-process — no test ever
 * touches the live network.
 *
 * The mock is deliberately a small in-memory chain rather than canned
 * responses: `sendTransaction` decodes the envelope the page actually built and
 * applies the call (`freeze` → frozen, `set_policy` → stores the encoded
 * policy), and later `simulateTransaction` reads that state back. That is what
 * lets the lifecycle test assert that a freeze signed on `/panic` is visible as
 * `FROZEN` on `/`, exactly as it would be on chain.
 *
 * XDR fidelity matters here: every response is built with `@stellar/stellar-sdk`
 * and must parse under the same SDK the browser bundle runs, including
 * `getLatestLedger`'s header/metadata (captured once from the real testnet into
 * `tests/fixtures/rpc-capture.json`) and the pinned Phase 1 bytecode in
 * `tests/fixtures/phase1-artifact.wasm`, whose SHA-256 the deploy flow verifies
 * in the browser. The fixture is the genuine artifact, so that check passes for
 * the real reason.
 *
 * Tests drive it through `installSorobanRpcMock`, which also acts as a
 * hermeticity net: anything that is not localhost and not this RPC host is
 * aborted.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page, Route } from "@playwright/test";
import {
  Address,
  Networks,
  SorobanDataBuilder,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";
import { NETWORK, PHASE1_ARTIFACT } from "../../lib/guard/network.ts";
import { hashToHex } from "../../lib/guard/scval.ts";
import { predictContractId } from "../../lib/guard/chain.ts";
import { specToGuardEvent, type MockEventSpec } from "../mocks/eventFixtures.ts";

const RPC_HOST = "soroban-testnet.stellar.org";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

interface RpcCapture {
  sequence: number;
  protocolVersion: number;
  closeTime: number;
  admin: string;
  headerXdr: string;
  metadataXdr: string;
  accountEntryXdr: string;
}

/** Per-contract mutable state, the part a transaction can change. */
interface GuardState {
  frozen: boolean;
  policy: xdr.ScVal | null;
}

/** A fixture event with the XDR pieces already encoded. */
interface EncodedEvent {
  ledger: number;
  ledgerClosedAt: string;
  transactionHash: string | null;
  topics: string[];
  value: string;
}

export interface MockChainOptions {
  /** Events served by `getEvents`, in ledger order. */
  events?: MockEventSpec[];
  /**
   * Max events returned per `getEvents` call. Defaults to "everything left",
   * which is what the specs want; the perf spec raises the fixture count
   * instead of relying on this.
   */
  eventBatchSize?: number;
  /**
   * What this chain says the Phase 1 artifact is (issue #351). Defaults to the
   * genuine fixture, so every other spec is unaffected.
   */
  artifact?: ArtifactMode;
}

/**
 * The artifact a mock chain serves, as the deploy gate reads it: the bytes of
 * the code entry *and* the hash the instance declares for them.
 *
 * Both are derived from the same bytes on purpose. A mismatched artifact
 * therefore declares its own hash, which keeps the mock internally consistent —
 * the failure the panel reports is a mismatch against the pin, not a torn read
 * where the ledger and the code entry disagree with each other.
 */
export type ArtifactMode =
  /** The genuine fixture: hash and byte length both match the pin. */
  | "pinned"
  /** The right length, bytes that hash to something that is not the pin. */
  | "hash-mismatch"
  /** More bytes than the pin allows — a length mismatch of its own. */
  | "length-mismatch";

function readJsonFixture<T>(relativePath: string): T {
  return JSON.parse(readFileSync(join(process.cwd(), relativePath), "utf8")) as T;
}

/** The topics Soroban's `#[contractevent]` vocabulary defines, encoded once. */
function encodeTopics(spec: MockEventSpec): string[] {
  const symbol = (value: string): string => xdr.ScVal.scvSymbol(value).toXDR("base64");
  if (spec.kind === "auth_checked") {
    const result = spec.decision?.result ?? "allowed";
    const reason = result === "blocked" ? (spec.decision?.reason ?? "blocked") : "";
    return [symbol("event_auth_checked"), symbol(result), symbol(reason)];
  }
  const topicByKind: Record<string, string> = {
    heartbeat: "event_heartbeat",
    initialized: "event_initialized",
    frozen: "event_frozen",
    unfrozen: "event_unfrozen",
    policy_set: "event_policy_set",
    policy_revoked: "event_policy_revoked",
  };
  return [symbol(topicByKind[spec.kind] ?? spec.kind)];
}

/** What one `invokeHostFunction` operation is asking the chain to do. */
interface ContractCall {
  contract: string;
  fn: string;
  args: xdr.ScVal[];
}

function decodeCall(transactionXdr: string): ContractCall | null {
  const tx = TransactionBuilder.fromXDR(transactionXdr, NETWORK.passphrase);
  const envelope = tx.toEnvelope();
  if (envelope.type !== "envelopeTypeTx") return null;
  for (const operation of envelope.v1.tx.operations) {
    const body = operation.body;
    if (body.type !== "invokeHostFunction") continue;
    const hostFunction = body.invokeHostFunctionOp.hostFunction;
    if (hostFunction.type !== "hostFunctionTypeInvokeContract") continue;
    const call = hostFunction.invokeContract;
    const rawName = call.functionName.bytes;
    const name = new TextDecoder().decode(
      rawName instanceof Uint8Array ? rawName : new Uint8Array(rawName as ArrayLike<number>),
    );
    return {
      contract: Address.fromScAddress(call.contractAddress).toString(),
      fn: name,
      args: call.args,
    };
  }
  return null;
}

/** The same module with one byte flipped: right length, wrong hash. */
function withFlippedByte(bytes: Uint8Array): Uint8Array {
  const copy = bytes.slice();
  const last = copy.length - 1;
  copy[last] = (copy[last] ?? 0) ^ 0xff;
  return copy;
}

/** The same module with a tail: wrong length, and a different hash too. */
function withExtraBytes(bytes: Uint8Array, extra: number): Uint8Array {
  const copy = new Uint8Array(bytes.length + extra);
  copy.set(bytes);
  return copy;
}

export class SorobanRpcMock {
  /** Every JSON-RPC method the page has asked for, in order (debug aid). */
  readonly requests: string[] = [];
  /** Events handed out so far — the specs assert the stream was consumed. */
  deliveredEvents = 0;
  /** Contracts created/frozen/… during the test, keyed by address. */
  readonly guards = new Map<string, GuardState>();
  /**
   * Which artifact this chain serves. Public so a spec can flip it mid-test —
   * mismatched, then valid again — without reloading the page, which is exactly
   * the recovery the deploy panel has to demonstrate (issue #351).
   */
  artifactMode: ArtifactMode;

  private readonly contractInstances = new Set<string>([PHASE1_ARTIFACT.guard]);

  private readonly capture: RpcCapture;
  private readonly wasm: Uint8Array;
  private readonly artifacts = new Map<ArtifactMode, { bytes: Uint8Array; hash: string }>();
  private readonly encodedEvents: EncodedEvent[];
  private readonly eventBatchSize: number | null;
  private readonly transactions = new Map<string, string>();
  private readonly sorobanDataB64: string;
  private readonly resultXdrB64: string;
  private readonly metaXdrB64: string;
  private cursor = 0;
  private latestLedger: number;

  constructor(options: MockChainOptions = {}) {
    this.capture = readJsonFixture<RpcCapture>("tests/fixtures/rpc-capture.json");
    this.latestLedger = this.capture.sequence;
    this.eventBatchSize = options.eventBatchSize ?? null;
    this.artifactMode = options.artifact ?? "pinned";

    this.wasm = new Uint8Array(
      readFileSync(join(process.cwd(), "tests/fixtures/phase1-artifact.wasm")),
    );
    const digest = createHash("sha256").update(this.wasm).digest("hex");
    if (digest !== PHASE1_ARTIFACT.wasmHash || this.wasm.length !== PHASE1_ARTIFACT.wasmBytes) {
      throw new Error(
        `tests/fixtures/phase1-artifact.wasm does not match the pinned artifact (${digest}, ${this.wasm.length} bytes)`,
      );
    }
    this.artifacts.set("pinned", { bytes: this.wasm, hash: digest });

    this.encodedEvents = (options.events ?? []).map((spec) => ({
      ledger: spec.ledger,
      ledgerClosedAt: spec.ledgerClosedAt,
      transactionHash: spec.transactionHash,
      topics: encodeTopics(spec),
      value: encodeEventValue(spec),
    }));

    this.sorobanDataB64 = new SorobanDataBuilder().setResourceFee(1_000).build().toXDR("base64");
    this.resultXdrB64 = new xdr.TransactionResult({
      feeCharged: xdr.Int64(100),
      result: xdr.TransactionResultResult.txSuccess([]),
      ext: xdr.TransactionResultExt.v0(),
    }).toXDR("base64");
    this.metaXdrB64 = xdr.TransactionMeta.v3(
      new xdr.TransactionMetaV3({
        ext: xdr.ExtensionPoint.v0(),
        txChangesBefore: [],
        operations: [],
        txChangesAfter: [],
        sorobanMeta: null,
      }),
    ).toXDR("base64");
  }

  /**
   * The bytes this chain serves as the Phase 1 artifact, with the hash the
   * ledger declares for them (issue #351).
   *
   * Derived once per mode and reused, so a spec that flips the mode back gets
   * byte-identical answers rather than a new random mismatch.
   */
  private activeArtifact(): { bytes: Uint8Array; hash: string } {
    const known = this.artifacts.get(this.artifactMode);
    if (known) return known;
    const bytes =
      this.artifactMode === "length-mismatch"
        ? withExtraBytes(this.wasm, 8)
        : withFlippedByte(this.wasm);
    const derived = { bytes, hash: createHash("sha256").update(bytes).digest("hex") };
    this.artifacts.set(this.artifactMode, derived);
    return derived;
  }

  /** How many `getEvents` pages the mock has served so far. */
  get eventPolls(): number {
    return this.requests.filter((method) => method === "getEvents").length;
  }

  private guard(address: string): GuardState {
    let state = this.guards.get(address);
    if (!state) {
      state = { frozen: false, policy: null };
      this.guards.set(address, state);
    }
    return state;
  }

  /** Answer one intercepted request. */
  async handle(route: Route): Promise<void> {
    const request = route.request();
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: CORS_HEADERS, body: "" });
      return;
    }
    if (request.method() !== "POST") {
      await route.fulfill({ status: 405, headers: CORS_HEADERS, body: "mock only answers POST" });
      return;
    }

    const body = request.postDataJSON() as { id?: number; method?: string; params?: never } | null;
    const method = body?.method ?? "unknown";
    this.requests.push(method);
    try {
      const result = await this.dispatch(method, body?.params ?? ({} as never));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: CORS_HEADERS,
        body: JSON.stringify({ jsonrpc: "2.0", id: body?.id ?? 1, result }),
      });
    } catch (error) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: CORS_HEADERS,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: body?.id ?? 1,
          error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
        }),
      });
    }
  }

  private ledgerFields() {
    return {
      latestLedger: this.latestLedger,
      latestLedgerCloseTime: Math.floor(Date.now() / 1000),
      oldestLedger: this.latestLedger - 1_000_000,
      oldestLedgerCloseTime: this.capture.closeTime,
    };
  }

  private async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "getHealth":
        return { status: "healthy", ...this.ledgerFields() };
      case "getNetwork":
        return {
          friendbotUrl: "https://friendbot.stellar.org",
          passphrase: NETWORK.passphrase,
          protocolVersion: this.capture.protocolVersion,
          network: NETWORK.name,
        };
      case "getLatestLedger":
        return {
          id: createHash("sha256").update(this.capture.headerXdr).digest("hex"),
          sequence: this.latestLedger,
          protocolVersion: this.capture.protocolVersion,
          closeTime: Math.floor(Date.now() / 1000),
          headerXdr: this.capture.headerXdr,
          metadataXdr: this.capture.metadataXdr,
        };
      case "getLedgerEntries":
        return this.getLedgerEntries((params["keys"] ?? []) as string[]);
      case "simulateTransaction":
        return this.simulate(String(params["transaction"] ?? ""));
      case "sendTransaction":
        return await this.sendTransaction(String(params["transaction"] ?? ""));
      case "getTransaction":
        return this.getTransaction(String(params["hash"] ?? ""));
      case "getEvents":
        return this.getEvents(params);
      default:
        throw new Error(`sorobanRpcMock: unexpected JSON-RPC method "${method}"`);
    }
  }

  private getLedgerEntries(keys: string[]) {
    const entries = [];
    for (const keyB64 of keys) {
      const entry = this.ledgerEntryForKey(keyB64);
      if (entry) entries.push(entry);
    }
    return { entries, ...this.ledgerFields() };
  }

  private ledgerEntryForKey(keyB64: string): Record<string, unknown> | null {
    const key = xdr.LedgerKey.fromXDR(keyB64, "base64");
    const lastModifiedLedgerSeq = this.latestLedger - 100;
    const liveUntilLedgerSeq = this.latestLedger + 100_000;

    if (key.type === "account") {
      // Only the mock admin's entry exists — and it is the captured one, so
      // sequence numbers come from a real account.
      return {
        key: keyB64,
        xdr: this.capture.accountEntryXdr,
        lastModifiedLedgerSeq,
        liveUntilLedgerSeq,
      };
    }

    if (key.type === "contractCode") {
      const active = this.activeArtifact();
      const requested = hashToHex(key.contractCode.hash);
      if (requested !== active.hash) return null;
      const entry = new xdr.ContractCodeEntry({
        ext: xdr.ContractCodeEntryExt.v0(),
        hash: new Uint8Array(Buffer.from(active.hash, "hex")),
        code: active.bytes,
      });
      return {
        key: keyB64,
        xdr: xdr.LedgerEntryData.contractCode(entry).toXDR("base64"),
        lastModifiedLedgerSeq,
        liveUntilLedgerSeq,
      };
    }

    if (key.type === "contractData") {
      const data = key.contractData;
      // Storage reads (the rolling `Window`, policy slots, …) resolve to "no
      // entry": the console renders that as an absent window, never as a zero.
      if (data.key.type === "scvVec") return null;
      if (data.key.type !== "scvLedgerKeyContractInstance") return null;
      const contractId = Address.fromScAddress(data.contract).toString();
      if (!this.contractInstances.has(contractId)) return null;
      // The instance lookup: every guard in these tests runs the pinned
      // artifact, which is what the deploy flow re-verifies after creation.
      const instance = new xdr.ContractDataEntry({
        ext: xdr.ExtensionPoint.v0(),
        contract: data.contract,
        key: data.key,
        durability: data.durability,
        val: xdr.ScVal.scvContractInstance(
          new xdr.ScContractInstance({
            executable: xdr.ContractExecutable.contractExecutableWasm(
              new Uint8Array(Buffer.from(this.activeArtifact().hash, "hex")),
            ),
            storage: [],
          }),
        ),
      });
      return {
        key: keyB64,
        xdr: xdr.LedgerEntryData.contractData(instance).toXDR("base64"),
        lastModifiedLedgerSeq,
        liveUntilLedgerSeq,
      };
    }

    return null;
  }

  private simulate(transactionXdr: string): Record<string, unknown> {
    const call = decodeCall(transactionXdr);
    let retval: xdr.ScVal = xdr.ScVal.scvVoid();
    if (call?.fn === "status") {
      const state = this.guard(call.contract);
      const now = BigInt(Math.floor(Date.now() / 1000));
      retval = nativeToScVal({
        has_policy: state.policy !== null,
        admin_frozen: state.frozen,
        heartbeat_expired: false,
        // Fresh enough that the dead-man switch reads "within grace".
        last_heartbeat: now - 24n,
        now,
      });
    } else if (call?.fn === "policy") {
      retval = this.guard(call.contract).policy ?? xdr.ScVal.scvVoid();
    }

    return {
      id: "mock-simulation",
      ...this.ledgerFields(),
      transactionData: this.sorobanDataB64,
      minResourceFee: "1000",
      results: [{ auth: [], xdr: retval.toXDR("base64") }],
    };
  }

  private async sendTransaction(transactionXdr: string): Promise<Record<string, unknown>> {
    const hash = createHash("sha256").update(Buffer.from(transactionXdr, "base64")).digest("hex");
    this.transactions.set(hash, transactionXdr);
    this.latestLedger += 1;

    const createdContract = await this.createdContractId(transactionXdr);
    if (createdContract) {
      this.contractInstances.add(createdContract);
      this.guards.set(createdContract, { frozen: false, policy: null });
    }

    // Apply the call's effect — the mock's version of consensus.
    const call = decodeCall(transactionXdr);
    if (call) {
      const state = this.guard(call.contract);
      switch (call.fn) {
        case "freeze":
          state.frozen = true;
          break;
        case "unfreeze":
          state.frozen = false;
          break;
        case "set_policy":
          state.policy = call.args[0] ?? xdr.ScVal.scvVoid();
          break;
        case "revoke_policy":
          state.policy = null;
          break;
        default:
          break;
      }
    }

    return { status: "PENDING", hash, ...this.ledgerFields() };
  }

  private async createdContractId(transactionXdr: string): Promise<string | null> {
    const transaction = TransactionBuilder.fromXDR(transactionXdr, NETWORK.passphrase);
    const envelope = transaction.toEnvelope();
    if (envelope.type !== "envelopeTypeTx") return null;
    for (const operation of envelope.v1.tx.operations) {
      const body = operation.body;
      if (body.type !== "invokeHostFunction") continue;
      const hostFunction = body.invokeHostFunctionOp.hostFunction;
      if (hostFunction.type !== "hostFunctionTypeCreateContractV2") continue;
      const preimage = hostFunction.createContractV2.contractIdPreimage;
      if (preimage.type !== "contractIdPreimageFromAddress") continue;
      const deployer = Address.fromScAddress(preimage.fromAddress.address).toString();
      return await predictContractId({
        deployerPublicKey: deployer,
        salt: preimage.fromAddress.salt.value,
      });
    }
    return null;
  }

  private getTransaction(hash: string): Record<string, unknown> {
    const envelopeXdr = this.transactions.get(hash);
    if (!envelopeXdr) {
      return { status: "NOT_FOUND", txHash: hash, ...this.ledgerFields() };
    }
    return {
      status: "SUCCESS",
      txHash: hash,
      ...this.ledgerFields(),
      createdAt: Math.floor(Date.now() / 1000),
      applicationOrder: 1,
      feeBump: false,
      ledger: this.latestLedger,
      envelopeXdr,
      resultXdr: this.resultXdrB64,
      resultMetaXdr: this.metaXdrB64,
    };
  }

  private getEvents(params: Record<string, unknown>): Record<string, unknown> {
    const pagination = (params["pagination"] ?? {}) as { cursor?: string; limit?: number };
    const filters = (params["filters"] ?? []) as Array<{ contractIds?: string[] }>;
    const contractId = filters[0]?.contractIds?.[0] ?? "";

    const start =
      pagination.cursor !== undefined && pagination.cursor !== null && pagination.cursor !== ""
        ? Number(pagination.cursor) || 0
        : 0;
    const end =
      this.eventBatchSize === null ? this.encodedEvents.length : start + this.eventBatchSize;
    const slice = this.encodedEvents.slice(start, Math.min(end, this.encodedEvents.length));
    const next = start + slice.length;
    this.deliveredEvents += slice.length;

    return {
      ...this.ledgerFields(),
      cursor: String(next),
      events: slice.map((event, index) => ({
        type: "contract",
        ledger: event.ledger,
        ledgerClosedAt: event.ledgerClosedAt,
        contractId,
        topic: event.topics,
        value: event.value,
        // Only a real transaction hash is served. `guardEventId` anchors a
        // committed event on its tx hash, so an empty string would hand every
        // no-transaction event (heartbeats) the same id and the feed's
        // de-duplication would collapse them into one row.
        ...(event.transactionHash ? { txHash: event.transactionHash } : {}),
        id: `${event.ledger}-${start + index}`,
        pagingToken: `${event.ledger}-${start + index}`,
      })),
    };
  }
}

/** The event body: `{}` for decisions, `{ at }` for heartbeats. */
function encodeEventValue(spec: MockEventSpec): string {
  return nativeToScVal(spec.data).toXDR("base64");
}

/**
 * Install the mock: all Soroban RPC traffic is answered in-process, localhost
 * passes through to the Next.js server, and anything else is aborted so a test
 * can never reach an unexpected host.
 */
export async function installSorobanRpcMock(
  page: Page,
  options: MockChainOptions = {},
): Promise<SorobanRpcMock> {
  const chain = new SorobanRpcMock(options);
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === RPC_HOST) return chain.handle(route);
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return route.continue();
    return route.abort();
  });
  return chain;
}

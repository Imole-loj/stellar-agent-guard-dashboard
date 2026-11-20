/**
 * Shared identity-switch race harness (issue #40).
 *
 * Every async surface the console renders has the same failure mode: a read
 * started for identity A resolves after the operator has switched to identity B,
 * and the late response paints A's data over B's view. `GuardProvider` owns the
 * one guard against it — the monotonic `readEpochRef` — so the tests here must
 * exercise *that* mechanism rather than a per-component copy.
 *
 * The fake server below holds each read open until the test releases it, keyed
 * by the contract address the read is about. That makes the interleaving exact:
 *
 *   mount → switch to A → switch to B → resolve B → resolve A (late) → assert
 *
 * `identityOf` is the parameterised axis: in production the identity is the
 * guard address, and the same helper is used with two servers to prove the
 * network-switch case (a server change bumps the same epoch) without waiting for
 * the multi-guard registry.
 *
 * Determinism rule (the visual-suite flake discipline applied to races): these
 * are deferred-promise tests, not sleep-based races. A flake here means the
 * epoch guard is broken, so fix the mechanism — never retry the test.
 */

import { Address, xdr, type rpc } from "@stellar/stellar-sdk";
import { policyToScVal, type PolicyConfig } from "stellar-agent-guard-sdk";
import { guardStatusScVal, sha256, windowScVal } from "../mocks/sorobanFixtures.ts";

export type Surface = "status" | "policy" | "window" | "identity";

/** The value each surface paints, in the probe's terms. */
export interface RaceValues {
  adminFrozen: boolean;
  /** `null` is the contract's default-deny policy, a successful read. */
  policyCap: bigint | null;
  /** `null` is a successful read with no persistent window entry. */
  windowTotal: bigint | null;
  /** Byte length of the wasm the instance claims to run. */
  identityBytes: number;
}

const DEFAULTS: RaceValues = {
  adminFrozen: false,
  policyCap: 1n,
  windowTotal: 1n,
  identityBytes: 1,
};

interface PendingRead {
  identity: string;
  surface: Surface;
  resolve: (response: unknown) => void;
}

export interface RaceServer {
  server: rpc.Server;
  /** Reads *started* for one identity (and surface), including those still held. */
  callsFor(identity: string, surface?: Surface): number;
  /** Reads for one identity (and surface) that the test has not released yet. */
  pendingFor(identity: string, surface?: Surface): number;
  /** Release every held read for an identity, optionally leaving one surface held. */
  resolveAll(identity: string, options?: { skip?: Surface; values?: Partial<RaceValues> }): void;
  resolveSurface(identity: string, surface: Surface, values?: Partial<RaceValues>): void;
  /** Release everything left over — for test cleanup, never for an assertion. */
  release(): void;
}

/** The contract address an invocation, ledger key or instance lookup names. */
export function decodeInvocation(tx: unknown): { guard: string; fn: string } {
  const raw = xdr.TransactionEnvelope.fromXDR((tx as { toXDR(): string }).toXDR(), "base64");
  const body = raw.type === "envelopeTypeTx" ? raw.v1.tx.operations[0]?.body : undefined;
  const hostFunction =
    body && body.type === "invokeHostFunction" ? body.invokeHostFunctionOp.hostFunction : undefined;
  if (!hostFunction || hostFunction.type !== "hostFunctionTypeInvokeContract") {
    return { guard: "", fn: "" };
  }
  const call = hostFunction.invokeContract;
  return {
    guard: Address.fromScAddress(call.contractAddress).toString(),
    fn: String(call.functionName),
  };
}

function ledgerKeyContract(key: unknown): string {
  const contract = (key as { contractData?: xdr.LedgerKeyContractData }).contractData?.contract;
  return contract ? Address.fromScAddress(contract).toString() : "";
}

function policyScVal(cap: bigint): xdr.ScVal {
  const config: PolicyConfig = {
    per_tx_cap: cap,
    window_secs: 60n,
    window_cap: 1000n,
    assets: [],
    protocols: [],
    recipients: [],
    allow_any_recipient: true,
    active_from: 0n,
    active_until: 0n,
    paused: false,
    dms_grace_secs: 0n,
  };
  return policyToScVal(config);
}

/** The shape `readContract` treats as a successful simulation. */
function simulationSuccess(retval: xdr.ScVal): unknown {
  return {
    result: { auth: [], retval },
    minResourceFee: "1",
    transactionData: undefined,
    latestLedger: 1,
  };
}

/**
 * A Soroban RPC server whose read surfaces are individually releasable.
 *
 * Only the calls the console's snapshot reads make are implemented; anything
 * else throws, so a test that reaches an unexpected read fails loudly instead
 * of silently receiving a fabricated value.
 */
export function createRaceServer(): RaceServer {
  const held: PendingRead[] = [];
  const calls = new Map<string, Record<Surface, number>>();
  const identityBytes = new Map<string, Uint8Array>();

  const count = (identity: string): Record<Surface, number> => {
    let entry = calls.get(identity);
    if (!entry) {
      entry = { status: 0, policy: 0, window: 0, identity: 0 };
      calls.set(identity, entry);
    }
    return entry;
  };

  const wasmFor = (identity: string): Uint8Array => {
    let bytes = identityBytes.get(identity);
    if (!bytes) {
      // A deterministic, identity-unique length so the probe can tell two
      // instances apart by the bytes they run.
      bytes = new Uint8Array(DEFAULTS.identityBytes + (identity.charCodeAt(0) % 7));
      identityBytes.set(identity, bytes);
    }
    return bytes;
  };

  const hold = (identity: string, surface: Surface): Promise<unknown> => {
    count(identity)[surface] += 1;
    return new Promise((resolve) => {
      held.push({ identity, surface, resolve });
    });
  };

  const responseFor = (surface: Surface, identity: string, values: RaceValues): unknown => {
    switch (surface) {
      case "status":
        return simulationSuccess(
          guardStatusScVal({
            admin_frozen: values.adminFrozen,
            has_policy: values.policyCap !== null,
            heartbeat_expired: false,
            last_heartbeat: 1n,
            now: 2n,
          }),
        );
      case "policy":
        // A void retval is the successful default-deny read. A cap is a real
        // policy, encoded by the same SDK function the application writes with.
        return simulationSuccess(
          values.policyCap === null ? xdr.ScVal.scvVoid() : policyScVal(values.policyCap),
        );
      case "window":
        return {
          entries:
            values.windowTotal === null
              ? []
              : [
                  {
                    val: {
                      contractData: {
                        val: () =>
                          windowScVal({ total: values.windowTotal as bigint, entries: [] }),
                      },
                    },
                  },
                ],
          latestLedger: 1,
        };
      case "identity": {
        const bytes = new Uint8Array(values.identityBytes);
        identityBytes.set(identity, bytes);
        return { executable: { wasmHash: sha256(bytes) } };
      }
    }
  };

  const releaseOne = (read: PendingRead, values: Partial<RaceValues>): void => {
    const merged = { ...DEFAULTS, ...values };
    if (read.surface === "identity") {
      // The bytes must be fixed before the instance response names their hash.
      identityBytes.set(read.identity, new Uint8Array(merged.identityBytes));
    }
    read.resolve(responseFor(read.surface, read.identity, merged));
  };

  const server = {
    async simulateTransaction(tx: unknown) {
      const { guard, fn } = decodeInvocation(tx);
      if (fn !== "status" && fn !== "policy") {
        throw new Error(`unexpected contract call in the race harness: ${fn || "(none)"}`);
      }
      return await hold(guard, fn);
    },
    async getLedgerEntries(key: unknown) {
      const identity = ledgerKeyContract(key);
      return await hold(identity, "window");
    },
    async getContractInstance(contractId: string) {
      return await hold(contractId, "identity");
    },
    async getContractWasmByContractId(contractId: string) {
      return wasmFor(contractId);
    },
  } as unknown as rpc.Server;

  const resolveSurface = (
    identity: string,
    surface: Surface,
    values: Partial<RaceValues> = {},
  ): void => {
    const index = held.findIndex((read) => read.identity === identity && read.surface === surface);
    if (index < 0) throw new Error(`no pending ${surface} read for ${identity}`);
    const [read] = held.splice(index, 1);
    releaseOne(read!, values);
  };

  return {
    server,
    callsFor: (identity, surface) => {
      const entry = calls.get(identity);
      if (!entry) return 0;
      return surface ? entry[surface] : entry.status + entry.policy + entry.window + entry.identity;
    },
    pendingFor: (identity, surface) =>
      held.filter(
        (read) => read.identity === identity && (surface === undefined || read.surface === surface),
      ).length,
    resolveAll: (identity, options = {}) => {
      const matches = held.filter(
        (read) => read.identity === identity && read.surface !== options.skip,
      );
      for (const read of matches) {
        held.splice(held.indexOf(read), 1);
        releaseOne(read, options.values ?? {});
      }
    },
    resolveSurface,
    release: () => {
      for (const read of held.splice(0)) releaseOne(read, {});
    },
  };
}

/** The default identity fixture used by the race tests, when a value is unset. */
export const RACE_DEFAULTS = DEFAULTS;

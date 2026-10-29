/**
 * Which guard the operator is looking at, and where that list comes from.
 *
 * The defaults are addresses that already exist on testnet because Phases 1 and 2
 * put them there, and each carries its provenance in the label so an operator can
 * tell evidence apart from a deployment of their own. Nothing about an instance is
 * cached here: only the address, its label and the network it belongs to are
 * remembered, and every number the UI shows is read from the chain on each refresh.
 *
 * Since #22 an operator may hold several guards, so the saved list is namespaced
 * *per network*: a Testnet address and a Mainnet address are never offered in the
 * same list, and a draft or filter remembered for one can never leak into the
 * other. The version-1 key (a single un-namespaced list) is migrated once, on the
 * next load, into the current network's bucket; the legacy key is then removed.
 */

import { NETWORK, PHASE1_ARTIFACT } from "./network.ts";
import {
  decodeVersionedRecord,
  encodeVersionedRecord,
  writeStoredValue,
} from "./versionedStorage.ts";

export interface GuardInstance {
  guard: string;
  label: string;
  /** The network this address belongs to, e.g. `"testnet"` (see `network.ts`). */
  network: string;
  /** ISO-8601 timestamp of when the operator saved this instance. */
  addedAt: string;
  /** Where this address came from, shown in the selector. */
  provenance: string;
}

/**
 * The `addedAt` a build-seeded instance carries. These are not operator-saved;
 * the timestamp is a fixed sentinel so the fixtures stay deterministic rather
 * than reading the clock at import time.
 */
export const KNOWN_INSTANCE_ADDED_AT = "1970-01-01T00:00:00.000Z";

/**
 * The guard a local standalone sandbox deployed, when this build was pointed at
 * one through `NEXT_PUBLIC_GUARD_CONTRACT_ID`.
 *
 * Without it a sandbox build would open on Phase 1's testnet address, which does
 * not exist on a local network, and the console would report every read as a
 * failure — technically honest, but useless for offline development. The address
 * is still only a *seed*: nothing about it is cached, and every number shown for
 * it is read from the local chain.
 */
function sandboxInstance(): GuardInstance | null {
  const guard = process.env.NEXT_PUBLIC_GUARD_CONTRACT_ID?.trim();
  if (!guard || !looksLikeContractAddress(guard)) return null;
  return {
    guard,
    label: "Local sandbox guard",
    network: NETWORK.name,
    addedAt: KNOWN_INSTANCE_ADDED_AT,
    provenance: "Deployed by scripts/start-local-sandbox.sh on the local standalone network.",
  };
}

const SANDBOX_INSTANCE = sandboxInstance();

/** The two addresses the earlier phases proved, offered as starting points. */
export const KNOWN_INSTANCES: readonly GuardInstance[] = [
  ...(SANDBOX_INSTANCE ? [SANDBOX_INSTANCE] : []),
  {
    guard: PHASE1_ARTIFACT.guard,
    label: "Phase 1 guard",
    network: NETWORK.name,
    addedAt: KNOWN_INSTANCE_ADDED_AT,
    provenance:
      "Phase 1's live instance. Frozen by its own dead-man switch — kept as evidence and deliberately never touched.",
  },
  {
    guard: "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44",
    label: "Phase 2 guard",
    network: NETWORK.name,
    addedAt: KNOWN_INSTANCE_ADDED_AT,
    provenance: "Phase 2's enforcement instance: the same artifact, used by the SDK's live tests.",
  },
] as const;

/** The versioned storage key: one saved-guard list per network. */
export const INSTANCE_STORAGE_PREFIX = "stellar-agent-guard-dashboard.instances.v2";
export const INSTANCE_REGISTRY_SCHEMA = "stellar-agent-guard/instance-registry";
export const INSTANCE_REGISTRY_VERSION = 2;
const UNKNOWN_ADDED_AT = "1970-01-01T00:00:00.000Z";

/** The namespaced storage key for a network's saved-guard list. */
export function instanceStorageKey(network: string): string {
  return `${INSTANCE_STORAGE_PREFIX}.${network}`;
}

/**
 * The pre-network-migration key: a single un-namespaced list.
 *
 * Read exactly once, the first time a load finds no v2 entry, and its contents
 * adopted into the current network's bucket. Kept as an exported constant so the
 * migration is unit-testable and the old key is never guessed at.
 */
export const LEGACY_INSTANCE_STORAGE_KEY = "stellar-agent-guard-dashboard.instances.v1";

/** Cap on saved instances, so a bad import cannot grow without bound. */
export const INSTANCE_LIMIT = 50;

/** The subset of `Storage` the store needs, so tests can inject a fake. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export interface InstanceLoadOptions {
  /** Which network's bucket to read. Defaults to this build's network. */
  network?: string;
  /** Injected storage; defaults to `localStorage`, `null` on the server. */
  storage?: StorageLike | null;
}

function defaultStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function resolve(options?: InstanceLoadOptions): { network: string; storage: StorageLike | null } {
  return {
    network: options?.network ?? NETWORK.name,
    storage: options?.storage === undefined ? defaultStorage() : options.storage,
  };
}

/**
 * A stable, readable default label for an address with no operator label.
 * Kept local so the registry module has no React dependency.
 */
export function defaultGuardLabel(guard: string): string {
  return `Guard ${guard.slice(0, 6)}…${guard.slice(-4)}`;
}

/**
 * The guard selected on a first visit: the first build-known instance. Living
 * here rather than in a component is deliberate — the default address is a
 * registry concern, so a consumer can never hardcode it.
 */
export function defaultInstance(): GuardInstance {
  return KNOWN_INSTANCES[0]!;
}

/** The address of `defaultInstance()`, for callers that only need the string. */
export function defaultGuard(): string {
  return KNOWN_INSTANCES[0]!.guard;
}

/** Coerce an untrusted stored entry into a `GuardInstance`, or reject it. */
function asInstance(value: unknown, network: string): GuardInstance | null {
  if (typeof value !== "object" || value === null) return null;
  const entry = value as Partial<GuardInstance>;
  if (typeof entry.guard !== "string" || !looksLikeContractAddress(entry.guard)) return null;
  return {
    guard: entry.guard,
    label:
      typeof entry.label === "string" && entry.label.trim() !== ""
        ? entry.label
        : defaultGuardLabel(entry.guard),
    // A v1 entry has no network; it belongs to the network this build runs on.
    network: typeof entry.network === "string" && entry.network !== "" ? entry.network : network,
    addedAt:
      typeof entry.addedAt === "string" && entry.addedAt !== "" ? entry.addedAt : UNKNOWN_ADDED_AT,
    provenance:
      typeof entry.provenance === "string" && entry.provenance !== ""
        ? entry.provenance
        : "Added from this browser.",
  };
}

function parseList(raw: string, network: string) {
  const decoded = decodeVersionedRecord({
    raw,
    schema: INSTANCE_REGISTRY_SCHEMA,
    version: INSTANCE_REGISTRY_VERSION,
    migrations: { 0: (value) => value, 1: (value) => value },
    validate: (value): value is unknown[] => Array.isArray(value),
  });
  if (!decoded.ok) return decoded;
  const parsed = decoded.value;
  const seen = new Set<string>();
  const out: GuardInstance[] = [];
  let migrationSafe = true;
  for (const entry of parsed) {
    const instance = asInstance(entry, network);
    if (!instance) {
      migrationSafe = false;
      continue;
    }
    if (seen.has(instance.guard)) continue;
    seen.add(instance.guard);
    out.push(instance);
  }
  return {
    ok: true,
    value: out.slice(0, INSTANCE_LIMIT),
    needsMigration: decoded.needsMigration,
    migrationSafe,
  };
}

type StoredList =
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "valid"; instances: GuardInstance[]; migrationSafe: boolean };

/** The namespaced stored list, preserving invalid and future-version values. */
function readNamespaced(network: string, storage: StorageLike | null): StoredList {
  if (!storage) return { kind: "missing" };
  try {
    const key = instanceStorageKey(network);
    const raw = storage.getItem(key);
    if (raw === null) return { kind: "missing" };
    const parsed = parseList(raw, network);
    if (!parsed.ok) return { kind: "invalid" };
    if (parsed.needsMigration && parsed.migrationSafe) {
      writeStoredValue(
        storage,
        key,
        encodeVersionedRecord(INSTANCE_REGISTRY_SCHEMA, INSTANCE_REGISTRY_VERSION, parsed.value),
      );
    }
    return { kind: "valid", instances: parsed.value, migrationSafe: parsed.migrationSafe };
  } catch {
    return { kind: "invalid" };
  }
}

function writeNamespaced(
  network: string,
  storage: StorageLike | null,
  instances: GuardInstance[],
): boolean {
  return writeStoredValue(
    storage,
    instanceStorageKey(network),
    encodeVersionedRecord(INSTANCE_REGISTRY_SCHEMA, INSTANCE_REGISTRY_VERSION, instances),
  ).ok;
}

/**
 * Adopt the version-1 list into this build's network bucket, once.
 *
 * The v1 list predates the network dimension, so its entries are assigned the
 * *build's* network (`NETWORK.name`) rather than whatever bucket happens to be
 * read first — a testnet-era list must never surface under Mainnet. Migration
 * runs only when the target v2 key is *absent*, so an empty (but present) v2
 * list is a real "the operator removed everything" state and is never re-seeded.
 * The legacy key is removed after the write, so migration cannot run twice.
 */
function migrateLegacy(storage: StorageLike | null): void {
  if (!storage) return;
  let raw: string | null;
  try {
    raw = storage.getItem(LEGACY_INSTANCE_STORAGE_KEY);
  } catch {
    return;
  }
  if (raw === null) return;
  const parsed = decodeVersionedRecord({
    raw,
    schema: INSTANCE_REGISTRY_SCHEMA,
    version: INSTANCE_REGISTRY_VERSION,
    migrations: { 0: (value) => value, 1: (value) => value },
    validate: (value): value is unknown[] => Array.isArray(value),
  });
  if (!parsed.ok) return;
  const legacy = parseList(JSON.stringify(parsed.value), NETWORK.name);
  if (!legacy.ok || !legacy.migrationSafe || legacy.value.length === 0) return;
  if (!writeNamespaced(NETWORK.name, storage, legacy.value)) return;
  try {
    storage.removeItem?.(LEGACY_INSTANCE_STORAGE_KEY);
  } catch {
    // Best-effort: the v2 key now exists, so migration will not run again.
  }
}

/** The stored list for a network, running the one-time v1 migration if needed. */
function readStored(network: string, storage: StorageLike | null): GuardInstance[] {
  const namespaced = readNamespaced(network, storage);
  if (namespaced.kind === "valid") return namespaced.instances;
  if (namespaced.kind === "invalid") return [];
  migrateLegacy(storage);
  const migrated = readNamespaced(network, storage);
  return migrated.kind === "valid" ? migrated.instances : [];
}

/** Instances the operator has added, plus the known ones, de-duplicated by address. */
export function loadInstances(options?: InstanceLoadOptions): GuardInstance[] {
  const { network, storage } = resolve(options);
  const seen = new Set<string>();
  const combined: GuardInstance[] = [];
  // Stored entries come first so an operator's rename of a known instance wins.
  for (const instance of [...readStored(network, storage), ...KNOWN_INSTANCES]) {
    if (seen.has(instance.guard)) continue;
    seen.add(instance.guard);
    combined.push(instance);
  }
  return combined;
}

/** The operator-saved entries only (no known instances), for writes. */
function loadSaved(options?: InstanceLoadOptions): {
  network: string;
  storage: StorageLike | null;
  saved: GuardInstance[];
} {
  const { network, storage } = resolve(options);
  return { network, storage, saved: readStored(network, storage) };
}

/**
 * The operator-saved entries only (no known instances), for callers that need
 * what is *stored* rather than what the selector shows — a backup of the
 * registry taken before a bulk cleanup, for instance. A build-seeded instance
 * the operator renamed is present as a saved shadow, which is exactly what is
 * on disk and exactly what a restore has to put back.
 */
export function loadSavedInstances(options?: InstanceLoadOptions): GuardInstance[] {
  return loadSaved(options).saved;
}

/**
 * Remember an instance the operator added so it survives a reload.
 *
 * Returns the combined list (known + saved) that resulted, so the caller can set
 * state from the single source of truth without a second read.
 */
export function rememberInstance(
  guard: string,
  label: string,
  options?: InstanceLoadOptions,
): GuardInstance[] {
  const trimmed = guard.trim();
  const { network, storage, saved } = loadSaved(options);
  if (KNOWN_INSTANCES.some((instance) => instance.guard === trimmed)) {
    return loadInstances({ network, storage });
  }
  const labelText = label.trim() === "" ? defaultGuardLabel(trimmed) : label.trim();
  const existing = saved.findIndex((instance) => instance.guard === trimmed);
  if (existing >= 0) {
    saved[existing] = { ...saved[existing]!, label: labelText };
  } else {
    saved.push({
      guard: trimmed,
      label: labelText,
      network,
      addedAt: new Date().toISOString(),
      provenance: "Added from this browser.",
    });
  }
  writeNamespaced(network, storage, saved.slice(-INSTANCE_LIMIT));
  return loadInstances({ network, storage });
}

/**
 * Rename a saved instance.
 *
 * A known (build-seeded) instance cannot be edited in place, so renaming one
 * writes a saved shadow that takes precedence on load; removing that shadow would
 * restore the build's own label. A blank label is ignored rather than wiping it.
 */
export function renameInstance(
  guard: string,
  label: string,
  options?: InstanceLoadOptions,
): GuardInstance[] {
  const trimmed = guard.trim();
  const nextLabel = label.trim();
  const { network, storage, saved } = loadSaved(options);
  if (nextLabel === "") return loadInstances({ network, storage });
  const index = saved.findIndex((instance) => instance.guard === trimmed);
  if (index >= 0) {
    saved[index] = { ...saved[index]!, label: nextLabel };
  } else {
    const known = KNOWN_INSTANCES.find((instance) => instance.guard === trimmed);
    if (!known) return loadInstances({ network, storage });
    saved.push({
      ...known,
      label: nextLabel,
      provenance: `Renamed from this browser. ${known.provenance}`,
    });
  }
  writeNamespaced(network, storage, saved.slice(-INSTANCE_LIMIT));
  return loadInstances({ network, storage });
}

/**
 * Remove an operator-saved instance. Removing a build-seeded instance is a
 * no-op: the known addresses are constants, not state, and cannot be deleted.
 */
export function removeInstance(guard: string, options?: InstanceLoadOptions): GuardInstance[] {
  const trimmed = guard.trim();
  const { network, storage, saved } = loadSaved(options);
  writeNamespaced(
    network,
    storage,
    saved.filter((instance) => instance.guard !== trimmed),
  );
  return loadInstances({ network, storage });
}

/** What one bulk write did, or failed to do, to the saved list. */
export interface BulkRemovalResult {
  /** False when the stored list could not be written; nothing changed then. */
  ok: boolean;
  /** The saved addresses the write actually removed. */
  removed: string[];
  /** The combined list (known + saved) after the attempt. */
  instances: GuardInstance[];
}

/**
 * Remove several operator-saved instances in one write (issue #302).
 *
 * One write rather than a loop of single removals: a bulk cleanup must land
 * whole or not at all, so the stored list is never left half-edited by a
 * failure partway through. Addresses are trimmed, de-duplicated, and a
 * build-seeded address is never a candidate — those are constants, not state,
 * so a selection that contains them is narrowed rather than obeyed.
 *
 * A storage failure is reported as `ok: false` with the list untouched; it
 * never throws, because a full disk is a reason to tell the operator, not a
 * reason to lose the exception.
 */
export function removeInstances(
  guards: readonly string[],
  options?: InstanceLoadOptions,
): BulkRemovalResult {
  const { network, storage, saved } = loadSaved(options);
  const targets = new Set<string>();
  for (const candidate of guards) {
    const trimmed = candidate.trim();
    if (trimmed === "" || isKnownInstance(trimmed)) continue;
    targets.add(trimmed);
  }
  const removed = saved
    .filter((instance) => targets.has(instance.guard))
    .map((instance) => instance.guard);
  // Nothing selected is saved: report success without touching storage, so an
  // empty or already-applied selection cannot be mistaken for a failed write.
  if (removed.length === 0) {
    return { ok: true, removed: [], instances: loadInstances({ network, storage }) };
  }
  const remaining = saved.filter((instance) => !targets.has(instance.guard));
  let ok = false;
  try {
    ok = writeNamespaced(network, storage, remaining);
  } catch {
    ok = false;
  }
  if (!ok) {
    return { ok: false, removed: [], instances: loadInstances({ network, storage }) };
  }
  return { ok: true, removed, instances: loadInstances({ network, storage }) };
}

/** What one restore did, or failed to do, to the saved list. */
export interface RegistryRestoreResult {
  /** False when the stored list could not be written; nothing changed then. */
  ok: boolean;
  /** How many captured entries were merged back in. */
  restored: number;
  /** The combined list (known + saved) after the attempt. */
  instances: GuardInstance[];
}

/**
 * Put a previously captured saved list back (issue #302).
 *
 * This is the one-step undo behind a bulk cleanup, so it *merges* the captured
 * entries into what is stored now rather than replacing it: everything the
 * cleanup removed comes back, and anything added since the backup was taken
 * survives the restore. Entries for another network, malformed addresses and
 * duplicates are dropped, and the list is capped like any other write.
 *
 * As with removal, a storage failure is reported rather than thrown.
 */
export function restoreInstances(
  entries: readonly GuardInstance[],
  options?: InstanceLoadOptions,
): RegistryRestoreResult {
  const { network, storage, saved } = loadSaved(options);
  const merged: GuardInstance[] = [];
  const seen = new Set<string>();
  for (const instance of [...entries, ...saved]) {
    if (instance.network !== network) continue;
    if (!looksLikeContractAddress(instance.guard)) continue;
    if (seen.has(instance.guard)) continue;
    seen.add(instance.guard);
    merged.push({ ...instance, network });
  }
  let ok = false;
  try {
    ok = writeNamespaced(network, storage, merged.slice(0, INSTANCE_LIMIT));
  } catch {
    ok = false;
  }
  if (!ok) {
    return { ok: false, restored: 0, instances: loadInstances({ network, storage }) };
  }
  const restored = merged.length - saved.length;
  return { ok: true, restored, instances: loadInstances({ network, storage }) };
}

/** True when the address is one of the build-seeded instances and cannot be deleted. */
export function isKnownInstance(guard: string): boolean {
  return KNOWN_INSTANCES.some((instance) => instance.guard === guard);
}

/** The saved entry for an address, or `null` when it is not saved. */
export function findInstance(guard: string, options?: InstanceLoadOptions): GuardInstance | null {
  return loadInstances(options).find((instance) => instance.guard === guard) ?? null;
}

/** A `C…` contract address, checked without pulling in the SDK. */
export function looksLikeContractAddress(value: string): boolean {
  return /^C[A-Z2-7]{55}$/.test(value.trim());
}

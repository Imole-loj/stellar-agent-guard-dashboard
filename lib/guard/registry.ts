/**
 * Adding a guard by address, with a live check before it is remembered.
 *
 * A `C…` string is not a guard. Typing an address into the selector and having
 * it stick would let the console claim it is watching an account that does not
 * exist, does not run the guard artifact, or is on a network this build cannot
 * read. The add flow therefore does two things in order, and persists nothing
 * until both pass:
 *
 *   1. Validate the StrKey (a Soroban `C…` contract address).
 *   2. Read the contract's own `status()` — the same read the panels use — and
 *      refuse the add when it traps or the transport fails.
 *
 * An operator-supplied label is additionally screened against the label policy
 * (`inputSanitizer.ts`) before either step, so a deceptive name is refused
 * without touching the network at all.
 *
 * It signs nothing: the add flow never touches a wallet, so there is no
 * `sendTransaction` on this path at all. That is asserted by call-count in
 * `registryLive.test.ts`, not merely intended.
 *
 * The registry itself (the saved list, its network namespacing and the one-time
 * v1 migration) lives in `instance.ts`; this module is the verified front door.
 */

import { StrKey, type rpc } from "@stellar/stellar-sdk";
import { readStatus } from "./chain.ts";
import { validateLabel } from "./inputSanitizer.ts";
import { NETWORK } from "./network.ts";
import type { RegistryChangeNotice } from "./tabSync.ts";
import {
  defaultGuardLabel,
  isKnownInstance,
  loadInstances,
  loadSavedInstances,
  looksLikeContractAddress,
  rememberInstance,
  restoreInstances,
  type GuardInstance,
  type InstanceLoadOptions,
  type StorageLike,
} from "./instance.ts";

/** Why an add was refused: a bad string, or a valid one that did not answer live. */
export type AddGuardKind = "invalid" | "unreachable";

export type LiveCheck = { ok: true } | { ok: false; error: string };

/**
 * A well-formed Soroban contract address: the fast `C…` shape check plus the
 * SDK's StrKey checksum. A string that only matches the regex (a typo'd
 * checksum) is rejected here, before any RPC call, so the operator gets an
 * "invalid" answer instantly rather than an "unreachable" one.
 */
export function isValidGuardAddress(value: string): boolean {
  const candidate = value.trim();
  if (!looksLikeContractAddress(candidate)) return false;
  try {
    return StrKey.isValidContract(candidate);
  } catch {
    return false;
  }
}

/**
 * Confirm an address is a live guard before it is offered.
 *
 * A non-`C…` string is rejected without any RPC call. A valid contract address is
 * read with `status()`; a trap (the contract exists but is not a guard, or has no
 * `status` entrypoint) and a transport failure are both refusals — the console
 * must not remember an address it could not confirm.
 */
export async function verifyGuardIsLive(server: rpc.Server, address: string): Promise<LiveCheck> {
  const candidate = address.trim();
  if (!isValidGuardAddress(candidate)) {
    return {
      ok: false,
      error: "That is not a valid Soroban contract address (a C… StrKey).",
    };
  }
  const result = await readStatus(server, candidate);
  if (!result.ok) {
    return { ok: false, error: `the guard did not answer status(): ${result.error}` };
  }
  const value = result.value as { has_policy?: unknown } | null | undefined;
  if (!value || typeof value.has_policy !== "boolean") {
    return {
      ok: false,
      error: "the contract answered status() but not in the guard's shape (no has_policy flag).",
    };
  }
  return { ok: true };
}

export interface AddGuardParams {
  server: rpc.Server;
  address: string;
  label?: string;
  /** Defaults to this build's network; see `instance.ts`. */
  network?: string;
  /** Injected storage for tests; defaults to `localStorage`. */
  storage?: StorageLike | null;
}

export type AddGuardResult =
  { ok: true; instance: GuardInstance } | { ok: false; kind: AddGuardKind; error: string };

/**
 * Validate and live-verify an address, then save it under the active network.
 *
 * Nothing is written on a failed check: the caller gets an inline error and the
 * saved list is untouched. No signature is requested at any point.
 */
export async function addGuard(params: AddGuardParams): Promise<AddGuardResult> {
  const address = params.address.trim();
  // The label is screened before any RPC call: a name carrying invisible or
  // control characters (issue #384) is refused with the same field-level
  // message the address book shows, and nothing is read or remembered.
  if (params.label !== undefined) {
    const labelCheck = validateLabel(params.label);
    if (!labelCheck.ok) return { ok: false, kind: "invalid", error: labelCheck.error };
  }
  const label = (params.label ?? "").trim() || defaultGuardLabel(address);
  const check = await verifyGuardIsLive(params.server, address);
  if (!check.ok) {
    return {
      ok: false,
      kind: isValidGuardAddress(address) ? "unreachable" : "invalid",
      error: check.error,
    };
  }
  const instances = rememberInstance(address, label, {
    ...(params.network === undefined ? {} : { network: params.network }),
    ...(params.storage === undefined ? {} : { storage: params.storage }),
  });
  const instance = instances.find((candidate) => candidate.guard === address);
  if (!instance) {
    return {
      ok: false,
      kind: "unreachable",
      error: "the guard passed its live check but could not be saved.",
    };
  }
  return { ok: true, instance };
}

// ── Following another tab's registry change ────────────────────────────────

/**
 * The instance list to hold after another tab changed the saved registry.
 *
 * `saved` is the registry as just re-read from storage — the authority. `current`
 * is what this tab was showing. The only thing kept from `current` is the active
 * guard when it is not in `saved` and was not the one just removed: a guard
 * adopted from a link lives only in this tab's list, and dropping it would leave
 * the selector without an option for the guard on screen.
 */
export function registryAfterChange(params: {
  saved: readonly GuardInstance[];
  current: readonly GuardInstance[];
  activeGuard: string;
  notice: Pick<RegistryChangeNotice, "kind" | "guard">;
}): GuardInstance[] {
  const { saved, current, activeGuard, notice } = params;
  const removedActive = notice.kind === "remove" && notice.guard === activeGuard;
  const active = current.find((instance) => instance.guard === activeGuard);
  if (active && !removedActive && !saved.some((instance) => instance.guard === activeGuard)) {
    return [...saved, active];
  }
  return [...saved];
}

// ── Bulk cleanup of stale registry entries (issue #302) ────────────────────

/** One entry a bulk cleanup is about to remove: exactly what the confirm shows. */
export interface CleanupEntry {
  guard: string;
  label: string;
  network: string;
}

export type BulkCleanupPlan =
  | {
      ok: false;
      kind: "empty" | "unchanged";
      /** Why nothing will be removed, in the operator's terms. */
      error: string;
      /** Addresses that were selected but cannot be deleted. */
      skipped: string[];
    }
  | {
      ok: true;
      /** De-duplicated, registry order, ready to be shown before confirming. */
      entries: CleanupEntry[];
      /** Addresses selected but left alone — build-seeded entries, or unknown. */
      skipped: string[];
    };

/**
 * Resolve a selection into the entries a confirmation step must show.
 *
 * Pure and storage-free: it decides *what* may be removed so the caller can
 * show the exact addresses and labels before anything is written. Three rules
 * are its whole job, and each is a way a bulk delete goes wrong otherwise:
 *
 *   - an empty selection is refused rather than treated as "everything";
 *   - duplicates collapse, so one address is never announced (or removed) twice;
 *   - build-seeded instances are skipped, because those addresses are constants
 *     of this build and deleting them would only pretend to work.
 */
export function planBulkCleanup(params: {
  instances: readonly GuardInstance[];
  selected: readonly string[];
}): BulkCleanupPlan {
  const targets: string[] = [];
  const seen = new Set<string>();
  for (const candidate of params.selected) {
    const trimmed = candidate.trim();
    if (trimmed === "" || seen.has(trimmed)) continue;
    seen.add(trimmed);
    targets.push(trimmed);
  }
  if (targets.length === 0) {
    return {
      ok: false,
      kind: "empty",
      error: "Select at least one registry entry to remove.",
      skipped: [],
    };
  }

  const entries: CleanupEntry[] = [];
  const skipped: string[] = [];
  const chosen = new Set<string>();
  for (const target of targets) {
    const instance = params.instances.find((candidate) => candidate.guard === target);
    if (!instance || isKnownInstance(target)) {
      skipped.push(target);
      continue;
    }
    if (chosen.has(target)) continue;
    chosen.add(target);
    entries.push({ guard: instance.guard, label: instance.label, network: instance.network });
  }

  if (entries.length === 0) {
    return {
      ok: false,
      kind: "unchanged",
      error:
        skipped.length > 0
          ? "None of those can be removed: build-seeded guards are constants of this build."
          : "None of the selected entries are in this browser's registry any more.",
      skipped,
    };
  }
  return { ok: true, entries, skipped };
}

/**
 * The local registry as it was, captured immediately before a bulk cleanup.
 *
 * Only the *saved* list is captured: a build-seeded instance is not stored, so
 * it has nothing to restore and cannot be lost. The active guard rides along so
 * an undo can also put the operator back on the account they were viewing.
 */
export interface RegistryBackup {
  network: string;
  capturedAt: string;
  activeGuard: string;
  entries: GuardInstance[];
}

export function captureRegistryBackup(
  params: { activeGuard?: string; network?: string; storage?: StorageLike | null } = {},
): RegistryBackup {
  const network = params.network ?? NETWORK.name;
  const storage = params.storage;
  return {
    network,
    capturedAt: new Date().toISOString(),
    activeGuard: params.activeGuard ?? "",
    entries: loadSavedInstances({
      network,
      ...(storage === undefined ? {} : { storage }),
    }),
  };
}

/**
 * Merge a captured registry back into the stored one (issue #302).
 *
 * A backup taken for another network is refused rather than applied: the saved
 * list is namespaced per network, and cross-writing it would put a Testnet
 * address into the Mainnet selector.
 */
export function restoreRegistryBackup(
  backup: RegistryBackup,
  options: InstanceLoadOptions = {},
): { ok: boolean; error: string | null; instances: GuardInstance[] } {
  const network = options.network ?? backup.network;
  if (backup.network !== network) {
    return {
      ok: false,
      error: "That restore point belongs to another network.",
      instances: loadInstances(options),
    };
  }
  const restored = restoreInstances(backup.entries, { ...options, network });
  if (!restored.ok) {
    return {
      ok: false,
      error: "The previous registry could not be written back — nothing was restored.",
      instances: restored.instances,
    };
  }
  return { ok: true, error: null, instances: restored.instances };
}

/**
 * The guard to move to when another tab deleted the one this tab is showing, or
 * `null` when no move is needed (a different guard changed, the guard is still
 * saved — a build-seeded guard cannot be deleted — or the change was not a
 * removal). The choice matches a local delete: the first remaining guard.
 */
export function fallbackAfterRemoval(params: {
  saved: readonly GuardInstance[];
  activeGuard: string;
  notice: Pick<RegistryChangeNotice, "kind" | "guard">;
  defaultGuard: string;
}): string | null {
  const { saved, activeGuard, notice, defaultGuard } = params;
  if (notice.kind !== "remove" || notice.guard !== activeGuard) return null;
  if (saved.some((instance) => instance.guard === activeGuard)) return null;
  return saved[0]?.guard ?? defaultGuard;
}

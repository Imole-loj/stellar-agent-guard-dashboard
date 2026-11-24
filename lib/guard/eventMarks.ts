/**
 * Operator marks on telemetry events: a bookmark and a private note (#482, #483).
 *
 * Both answer the same operational problem from opposite ends — "come back to this
 * row later" and "write down what I think about it" — so they share one record, one
 * identity rule and one persistence seam. What they must never share is the event
 * itself:
 *
 *   - A mark is **never** hung on a `GuardEvent`. Every exporter in this console is
 *     a function of `GuardEvent[]` and reads no browser storage
 *     (`exportScope.ts` relies on exactly that), so keeping marks in a side map
 *     keyed by event identity is what makes "notes are not in the export" true by
 *     construction rather than by review. The same rule keeps a note out of a
 *     transaction: nothing here is ever handed to a builder or a signer.
 *   - A mark says nothing about the chain. It is the operator's own annotation, and
 *     the UI says so in words on every row that carries one, because the failure
 *     mode this issue names is a note being read back as something the guard or the
 *     agent said.
 *
 * Identity is the SDK's `event.id` (`ledger:<txHash>:<topic>` for a committed row,
 * `diag:<sha256>` for a refusal — `stellar-agent-guard-sdk`, `dist/telemetry.d.ts`),
 * which is already this feed's de-duplication key and React key, so a mark attaches
 * to exactly the thing the feed considers unique. Two consequences are stated rather
 * than hidden:
 *
 *   - A diagnostic id is a hash of its *content*, so two refusals that decode
 *     identically share one mark. They are indistinguishable in the feed already;
 *     a bookmark cannot be more precise than the identity the feed has.
 *   - A diagnostic row has no ledger to re-read from. The `anchored` flag on the
 *     identity is what the UI uses to say "no ledger to re-read this from" instead
 *     of offering the permalink re-read that #485 built for committed rows.
 *
 * Storage reuses the per-guard scoped namespace (`guardScoped.ts`): one key per
 * (network, guard), so a bookmark made against guard A is not silently applied to a
 * same-looking event id under guard B, and deleting a guard clears its marks through
 * the existing cascade. The payload is a versioned envelope, so a record written by
 * a future build is refused rather than misread.
 */

import type { GuardEvent } from "stellar-agent-guard-sdk";
import { SCOPED_STORAGE_PREFIX, scopedStorageKey } from "./guardScoped.ts";
import { findSecretKeyInText } from "./inputSanitizer.ts";
import type { StorageLike } from "./instance.ts";
import { NETWORK } from "./network.ts";
import {
  decodeVersionedRecord,
  encodeVersionedRecord,
  storageErrorMessage,
  writeStoredValue,
  type StorageErrorKind,
} from "./versionedStorage.ts";

/**
 * The scoped base these marks live under. Adding it to `SCOPED_STORAGE_BASES` is
 * what enrols it in the guard-delete cascade and in the privacy inventory, both of
 * which enumerate that closed list.
 */
export const EVENT_MARKS_SCOPED_BASE = "eventMarks";

export const EVENT_MARKS_SCHEMA = "stellar-agent-guard/event-marks";
export const EVENT_MARKS_VERSION = 1;

/** Cap on one note, so a pasted blob cannot bloat the record. */
export const EVENT_NOTE_MAX_LENGTH = 500;

/**
 * Cap on the marks held per guard. Reaching it refuses the new mark rather than
 * evicting an old one: an operator returning to a bookmark they saved last week
 * would rather be told the list is full than find the entry quietly gone.
 */
export const EVENT_MARKS_LIMIT = 200;

/** What the operator recorded against one event. */
export interface EventMark {
  bookmarked: boolean;
  /** `""` when there is no note. Never absent, so a note-only row still reads. */
  note: string;
  /** ISO instant of the last change, for the "saved" line and for ordering. */
  updatedAt: string;
}

/** The marks for one guard, keyed by the event's stable identity. */
export type GuardMarks = Record<string, EventMark>;

/** The patch the UI sends: whichever half of the mark the operator touched. */
export interface MarkPatch {
  bookmarked?: boolean;
  note?: string;
}

export type EventMarkFailure =
  /** Nothing to scope the mark to, or nothing stable to key it on. */
  | "unaddressed"
  /** The operator typed something that looks like a secret key into a note. */
  | "secret-key"
  /** This guard's mark list is at `EVENT_MARKS_LIMIT`. */
  | "full"
  /** Browser storage refused or could not be read (see `versionedStorage.ts`). */
  | StorageErrorKind;

export type EventMarkOutcome =
  | {
      ok: true;
      /** The resulting mark, or `null` when the last half of it was removed too. */
      mark: EventMark | null;
      /** False when the change is in memory only because storage refused it. */
      persisted: boolean;
    }
  | { ok: false; error: EventMarkFailure; message: string };

/** Why a stored record could not be read, kept so the panel can say it once. */
export interface EventMarksNotice {
  error: EventMarkFailure;
  message: string;
}

/**
 * The two things about an event that a mark needs: the guard bucket it is stored
 * under, and the key inside that bucket. `anchored` is the ledger-identity
 * distinction #482 asks for — a row that is not anchored cannot be re-read from
 * the chain later, only remembered.
 */
export interface EventIdentity {
  guard: string;
  id: string;
  anchored: boolean;
}

/**
 * The identity a mark can be keyed on, or `null` when nothing can.
 *
 * A row with no emitting contract has no bucket to live in, and a diagnostic that
 * arrived without the SDK's `id` has no content hash to reconstruct it from; both
 * render no affordance rather than a mark that would land somewhere wrong. The
 * committed fallback recomputes the SDK's own `ledger:` form for hand-built rows.
 */
export function eventIdentityOf(event: GuardEvent): EventIdentity | null {
  const guard = typeof event.contractId === "string" ? event.contractId.trim() : "";
  if (guard === "") return null;
  const declared = typeof event.id === "string" ? event.id.trim() : "";
  if (declared !== "") {
    return { guard, id: declared, anchored: event.source === "ledger" };
  }
  if (event.source !== "ledger") return null;
  if (event.transactionHash === null && event.ledger === null) return null;
  return {
    guard,
    id: `ledger:${event.transactionHash ?? event.ledger}:${event.topic}`,
    anchored: true,
  };
}

/**
 * Operator note text, made safe to store.
 *
 * Trimmed, newline-normalised and capped. It is not HTML-escaped here because
 * React escapes on render and the text never reaches an export; it is *checked*
 * for a secret key, which is the one content this console refuses to persist
 * anywhere (`secretKeyPersistence.test.ts`, and the same rule `validateWebhookUrl`
 * applies to credentials).
 */
export function normalizeNote(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\r\n?/g, "\n")
    .trim()
    .slice(0, EVENT_NOTE_MAX_LENGTH);
}

/** A note that would persist a secret key, or `null` when the text is storable. */
export function findSecretInNote(value: string): string | null {
  return findSecretKeyInText(value);
}

/**
 * The reason a note was refused, as the clause `markRejected()` puts after
 * "Note was not saved:". It names what was found without quoting it: echoing a
 * pasted secret back into the DOM is the same leak in miniature.
 */
export const SECRET_NOTE_REJECTED =
  "it contains what looks like a secret key, which this console never stores";

/** The reason a mark is refused at `EVENT_MARKS_LIMIT`, as a clause for `markRejected()`. */
export const MARKS_FULL_REJECTED = `this guard already holds ${EVENT_MARKS_LIMIT} marks; remove a bookmark or note before adding another`;

/**
 * Whether two marks say the same thing, ignoring when they were last touched.
 *
 * The UI needs this because an announcement of a change the operator did not make is
 * a lie: saving an empty note on a row that never had one removes nothing.
 */
export function sameMark(a: EventMark | null, b: EventMark | null): boolean {
  if (a === null || b === null) return a === b;
  return a.bookmarked === b.bookmarked && a.note === b.note;
}

/** True for any value that can be shown as a mark; anything else is dropped. */
function isEventMark(value: unknown): value is EventMark {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.bookmarked !== "boolean") return false;
  if (typeof record.note !== "string") return false;
  if (typeof record.updatedAt !== "string") return false;
  // An entry with neither half is a leftover, not a mark.
  return record.bookmarked || record.note.trim() !== "";
}

/**
 * A stored marks record, validated entry by entry.
 *
 * One unreadable entry is dropped rather than discarding the record: an operator
 * who finds the file by hand and mistypes one field should lose that note, not
 * every bookmark they own.
 */
export function parseGuardMarks(value: unknown): GuardMarks {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const out: GuardMarks = {};
  for (const [id, entry] of Object.entries(value)) {
    if (id.trim() === "" || !isEventMark(entry)) continue;
    const mark = entry as EventMark;
    out[id] = {
      bookmarked: mark.bookmarked,
      note: normalizeNote(mark.note),
      updatedAt: mark.updatedAt,
    };
  }
  return out;
}

/**
 * What the UI says about a mark's provenance (#483's "browser-local indicator").
 *
 * The failure mode the issue names is a note being read back later as something the
 * *guard* recorded, so the row states where the text came from rather than leaving
 * it to be inferred from its position in a table of chain data.
 */
export const MARKS_ARE_BROWSER_LOCAL =
  "Yours, in this browser only — not something the guard, the agent or the ledger recorded.";

/** An empty bucket, shared so a cache miss is identity-stable across renders. */
const EMPTY_MARKS: GuardMarks = {};

function defaultStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    // Private mode or blocked cookies: the marks stay in memory for the session.
    return null;
  }
}

/** The `window` subset the cross-tab re-read needs, so tests can fake it. */
export interface EventMarksEventTarget {
  addEventListener(type: "storage", listener: (event: { key: string | null }) => void): void;
  removeEventListener(type: "storage", listener: (event: { key: string | null }) => void): void;
}

export interface EventMarksStore {
  /**
   * The mark on this event, or `null`.
   *
   * A pure cache read: it never touches storage, because it runs during render for
   * every visible row. `observe()` is what loads a bucket, and it runs after mount
   * so the server markup and the first client render agree.
   */
  markFor(event: GuardEvent): EventMark | null;
  /**
   * Marks for one guard as currently held, for the panel's "n saved" counts.
   * Another pure cache read — see the note on the implementation.
   */
  marksOf(guard: string): GuardMarks;
  /**
   * Load the buckets for the guards on screen. Called from an effect: reading
   * storage during the hydration render is the mismatch this store's
   * `getServerSnapshot` exists to avoid.
   */
  observe(guards: readonly string[]): void;
  /** Guards whose marks have been loaded, for the panel's own scope statement. */
  observedGuards(): readonly string[];
  /** Apply the patch, persist it, and say what happened. */
  applyMark(event: GuardEvent, patch: MarkPatch, now?: () => string): EventMarkOutcome;
  /** Every mark that could not be read, since the last successful read. */
  notice(): EventMarksNotice | null;
  /** `true` while any bucket holds a mark, so the panel can offer "bookmarked only". */
  hasAnyMark(): boolean;
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => number;
  getServerSnapshot: () => number;
  /** The prefix the delete cascade and the storage explorer both enumerate. */
  storageKeyFor(guard: string): string;
  /** Drop every cache so a test starts from empty storage. */
  resetForTesting(): void;
}

/**
 * The store for one network's operator marks.
 *
 * The snapshot is a revision counter rather than the map itself: rows are memoised
 * and read through `markFor`, whose returned object is identity-stable until that
 * one mark changes. So a bookmark re-renders the panel (for the counts) and the one
 * row whose prop changed, and leaves the other 249 memoised rows alone — which is
 * the property #114's benchmark exists to protect.
 */
export function createEventMarksStore(options?: {
  network?: string;
  storage?: StorageLike | null;
  eventTarget?: EventMarksEventTarget | null;
  /** Injectable clock so `updatedAt` is assertable. */
  now?: () => string;
}): EventMarksStore {
  const network = options?.network ?? NETWORK.name;
  const explicitStorage = options?.storage;
  const eventTarget =
    options?.eventTarget === undefined
      ? typeof window === "undefined"
        ? null
        : (window as unknown as EventMarksEventTarget)
      : options.eventTarget;
  const clock = options?.now ?? (() => new Date().toISOString());

  const buckets = new Map<string, GuardMarks>();
  const listeners = new Set<() => void>();
  let revision = 0;
  let observed = "";
  let currentNotice: EventMarksNotice | null = null;

  const resolveStorage = (): StorageLike | null =>
    explicitStorage === undefined ? defaultStorage() : explicitStorage;

  function readBucket(guard: string): GuardMarks {
    const storage = resolveStorage();
    const key = scopedStorageKey(EVENT_MARKS_SCOPED_BASE, network, guard);
    if (!storage) return {};
    let raw: string | null = null;
    try {
      raw = storage.getItem(key);
    } catch {
      currentNotice = { error: "unavailable", message: storageErrorMessage("unavailable") };
      return {};
    }
    if (raw === null || raw === "") return {};
    const decoded = decodeVersionedRecord<unknown>({
      raw,
      schema: EVENT_MARKS_SCHEMA,
      version: EVENT_MARKS_VERSION,
      migrations: {},
      validate: (value): value is unknown => typeof value === "object" && value !== null,
    });
    if (!decoded.ok) {
      // Readable-but-unreadable is reported, never silently rewritten: the bytes
      // stay where an operator can recover them until they make a new mark.
      currentNotice = { error: decoded.error, message: storageErrorMessage(decoded.error) };
      return {};
    }
    return parseGuardMarks(decoded.value);
  }

  function bucket(guard: string): GuardMarks {
    const cached = buckets.get(guard);
    if (cached) return cached;
    const loaded = readBucket(guard);
    buckets.set(guard, loaded);
    return loaded;
  }

  function persist(guard: string, marks: GuardMarks): boolean {
    const storage = resolveStorage();
    const key = scopedStorageKey(EVENT_MARKS_SCOPED_BASE, network, guard);
    if (Object.keys(marks).length === 0) {
      // No marks, no key: an empty bucket is removed rather than stored, so the
      // storage explorer and the delete cascade see the same absence the operator
      // just created.
      try {
        if (storage && typeof storage.removeItem === "function") storage.removeItem(key);
        else if (storage) storage.setItem(key, "");
      } catch {
        currentNotice = { error: "unknown", message: storageErrorMessage("unknown") };
        return false;
      }
      currentNotice = null;
      return true;
    }
    const written = writeStoredValue(
      storage,
      key,
      encodeVersionedRecord(EVENT_MARKS_SCHEMA, EVENT_MARKS_VERSION, marks),
    );
    if (!written.ok) {
      currentNotice = { error: written.error, message: storageErrorMessage(written.error) };
      return false;
    }
    // A write that succeeded retires the earlier complaint. Leaving it set would
    // keep the panel warning about a storage failure the operator has outlived.
    currentNotice = null;
    return true;
  }

  function bump(): void {
    revision += 1;
    for (const listener of [...listeners]) listener();
  }

  function onStorage(event: { key: string | null }): void {
    const prefix = `${SCOPED_STORAGE_PREFIX}.${EVENT_MARKS_SCOPED_BASE}.`;
    if (event.key !== null && !event.key.startsWith(prefix)) return;
    // Another tab changed a mark. Re-read rather than trusting a payload, which
    // is the rule every other cross-tab path in this console follows (§7 of SPEC).
    buckets.clear();
    if (observed === "") {
      bump();
      return;
    }
    for (const guard of observed.split(",")) bucket(guard);
    bump();
  }

  return {
    markFor(event) {
      const identity = eventIdentityOf(event);
      if (identity === null) return null;
      return buckets.get(identity.guard)?.[identity.id] ?? null;
    },
    marksOf(guard) {
      // A cache read, like `markFor`: this runs during render for the panel's own
      // counts, and a storage read here would put bytes of `localStorage` into the
      // hydration render. `observe()` is the only loader.
      return buckets.get(guard) ?? EMPTY_MARKS;
    },
    observe(guards) {
      const next = [...new Set(guards.filter((guard) => guard !== ""))].sort().join(",");
      if (next === observed) return;
      observed = next;
      let changed = false;
      for (const guard of next === "" ? [] : next.split(",")) {
        if (buckets.has(guard)) continue;
        buckets.set(guard, readBucket(guard));
        changed = true;
      }
      if (changed) bump();
    },
    observedGuards() {
      return observed === "" ? [] : observed.split(",");
    },
    applyMark(event, patch, now) {
      const identity = eventIdentityOf(event);
      if (identity === null) {
        return {
          ok: false,
          error: "unaddressed",
          message: "this row has no stable event identity to save against",
        };
      }
      const marks = bucket(identity.guard);
      const current = marks[identity.id];
      const note = normalizeNote(patch.note ?? current?.note ?? "");
      if (note !== "" && findSecretInNote(note) !== null) {
        return { ok: false, error: "secret-key", message: SECRET_NOTE_REJECTED };
      }
      const bookmarked = patch.bookmarked ?? current?.bookmarked ?? false;
      const isNew = current === undefined;
      if (!bookmarked && note === "") {
        if (!isNew) {
          const next: GuardMarks = { ...marks };
          delete next[identity.id];
          buckets.set(identity.guard, next);
          const persisted = persist(identity.guard, next);
          bump();
          return { ok: true, mark: null, persisted };
        }
        return { ok: true, mark: null, persisted: true };
      }
      if (isNew && Object.keys(marks).length >= EVENT_MARKS_LIMIT) {
        return { ok: false, error: "full", message: MARKS_FULL_REJECTED };
      }
      const mark: EventMark = { bookmarked, note, updatedAt: (now ?? clock)() };
      const next: GuardMarks = { ...marks, [identity.id]: mark };
      buckets.set(identity.guard, next);
      const persisted = persist(identity.guard, next);
      bump();
      return { ok: true, mark, persisted };
    },
    notice() {
      return currentNotice;
    },
    hasAnyMark() {
      for (const marks of buckets.values()) {
        if (Object.keys(marks).length > 0) return true;
      }
      return false;
    },
    subscribe(listener) {
      if (listeners.size === 0) eventTarget?.addEventListener("storage", onStorage);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) eventTarget?.removeEventListener("storage", onStorage);
      };
    },
    getSnapshot: () => revision,
    // The server has no marks to show, and the first client render must agree with
    // the markup it is replacing (`fleetTableState.ts` documents the same rule).
    getServerSnapshot: () => 0,
    storageKeyFor: (guard) => scopedStorageKey(EVENT_MARKS_SCOPED_BASE, network, guard),
    resetForTesting() {
      buckets.clear();
      observed = "";
      currentNotice = null;
      revision = 0;
    },
  };
}

/** The store the feed binds to: this build's network, this browser's storage. */
export const eventMarks = createEventMarksStore();

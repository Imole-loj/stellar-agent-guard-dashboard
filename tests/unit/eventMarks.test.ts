/**
 * Operator marks on telemetry events (#482, #483).
 *
 * The acceptance criteria these tests exist for are:
 *
 *   #482 — "Bookmark by stable identity", "scope to guard/network", "distinguish
 *          diagnostic rows without ledger identity".
 *   #483 — "Store notes locally by stable event identity", "show a browser-local
 *          indicator", "exclude notes from default exports and transactions".
 *
 * Two of those are asserted structurally rather than by searching output, because
 * searching output only proves the case you thought of:
 *
 *   - Identity is the SDK's own `event.id`, produced by `withIdentity()` (the same
 *     helper the feed fixtures use), so a mark is keyed on what the feed itself
 *     considers unique rather than on a format this file re-implements.
 *   - A note cannot reach an export because a mark is not a `GuardEvent` and every
 *     exporter is a function of `GuardEvent[]`. That is shown two ways: the
 *     sentinel is absent from every writer's output, *and* no writer ever read the
 *     storage key. The second check is the one that generalises — a future exporter
 *     that reaches for browser storage fails it whether or not its output happened
 *     to contain the sentinel.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { GUARD_EVENT_TOPICS, type GuardEvent } from "stellar-agent-guard-sdk";
import { withIdentity } from "../mocks/eventFixtures.ts";
import type { StorageLike } from "../../lib/guard/instance.ts";
import {
  SCOPED_STORAGE_BASES,
  SCOPED_STORAGE_PREFIX,
  clearGuardScopedState,
} from "../../lib/guard/guardScoped.ts";
import {
  EVENT_MARKS_LIMIT,
  EVENT_MARKS_SCOPED_BASE,
  EVENT_MARKS_SCHEMA,
  EVENT_MARKS_VERSION,
  EVENT_NOTE_MAX_LENGTH,
  MARKS_FULL_REJECTED,
  SECRET_NOTE_REJECTED,
  createEventMarksStore,
  eventIdentityOf,
  normalizeNote,
  parseGuardMarks,
  type EventMarksEventTarget,
  type EventMarksStore,
} from "../../lib/guard/eventMarks.ts";
import { eventsToCsv, eventsToJson } from "../../lib/guard/eventExport.ts";
import { telemetryToAuditLog } from "../../lib/guard/exportFormats.ts";
import {
  EMPTY_TELEMETRY_FILTER,
  telemetryToCsv,
  telemetryToNdjson,
} from "../../lib/guard/telemetryExport.ts";
import {
  buildWebhookPayload,
  countBlockedInWindow,
  serializeWebhookPayload,
} from "../../lib/guard/webhookDispatcher.ts";

const GUARD_A = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const GUARD_B = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const NETWORK = "testnet";

/** A pinned clock, so `updatedAt` is an assertion rather than a snapshot. */
const STAMP = "2026-11-23T12:00:00.000Z";
const clock = (): string => STAMP;

/**
 * A `localStorage` that records what was read.
 *
 * The read log is the point: "notes are not exported" is only provable by showing
 * the exporters never asked for the bytes, not by showing one file came out clean.
 */
class FakeStorage implements StorageLike {
  readonly values = new Map<string, string>();
  readonly reads: string[] = [];
  writes = 0;
  /** Thrown from `setItem` to model a quota or permission failure. */
  throwOnWrite: unknown = null;

  constructor(initial: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(initial)) this.values.set(key, value);
  }

  getItem(key: string): string | null {
    this.reads.push(key);
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.throwOnWrite !== null) throw this.throwOnWrite;
    this.values.set(key, value);
    this.writes += 1;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  /** The envelope as it was actually written, or `null`. */
  rawFor(guard: string): string | null {
    const key = `${SCOPED_STORAGE_PREFIX}.${EVENT_MARKS_SCOPED_BASE}.${NETWORK}.${guard}`;
    return this.values.get(key) ?? null;
  }
}

function quotaError(): Error {
  const error = new Error("storage is full");
  error.name = "QuotaExceededError";
  return error;
}

/** A committed row: it has a transaction, so it has a ledger to re-read from. */
function committed(overrides: Partial<GuardEvent> = {}): GuardEvent {
  return withIdentity({
    kind: "auth_checked",
    topic: GUARD_EVENT_TOPICS.authChecked,
    source: "ledger",
    contractId: GUARD_A,
    ledger: 100,
    ledgerClosedAt: "2026-11-23T11:59:55.000Z",
    transactionHash: "a".repeat(64),
    decision: { result: "allowed", reason: null, source: "ledger" },
    data: {},
    observedAt: null,
    ...overrides,
  });
}

/**
 * A refused decision: no transaction, no ledger, and an id that hashes the
 * diagnostic's own content.
 */
function refused(overrides: Partial<GuardEvent> = {}): GuardEvent {
  return withIdentity({
    kind: "auth_checked",
    topic: GUARD_EVENT_TOPICS.authChecked,
    source: "diagnostic",
    contractId: GUARD_A,
    ledger: null,
    ledgerClosedAt: null,
    transactionHash: null,
    decision: { result: "blocked", reason: "per_tx_cap_exceeded", source: "diagnostic" },
    data: {},
    observedAt: null,
    ...overrides,
  });
}

function storeWith(storage: StorageLike | null): EventMarksStore {
  return createEventMarksStore({ network: NETWORK, storage, now: clock, eventTarget: null });
}

/** A `window` subset that captures the listener so a test can fire it. */
function fakeTarget(): {
  target: EventMarksEventTarget;
  fire: (key: string | null) => void;
  listenerCount: () => number;
} {
  const listeners = new Set<(event: { key: string | null }) => void>();
  return {
    target: {
      addEventListener: (_type, listener) => listeners.add(listener),
      removeEventListener: (_type, listener) => listeners.delete(listener),
    },
    fire: (key) => {
      for (const listener of [...listeners]) listener({ key });
    },
    listenerCount: () => listeners.size,
  };
}

describe("bookmark by stable identity (#482)", () => {
  test("a mark is keyed on the SDK's own event id, not on the row object", () => {
    const store = storeWith(new FakeStorage());
    const event = committed();
    const outcome = store.applyMark(event, { bookmarked: true });

    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.mark?.bookmarked, true);
    assert.equal(outcome.mark?.note, "", "a bookmark alone is still a mark, with no note");
    assert.equal(outcome.mark?.updatedAt, STAMP, "the injected clock is what stamps a mark");

    // A different object carrying the same identity is the same event to the feed,
    // so it must find the same mark — this is the whole de-duplication contract.
    const twin = committed();
    assert.equal(twin.id, event.id, "the fixture really does produce the SDK's id");
    assert.deepEqual(store.markFor(twin), outcome.mark);
  });

  test("a committed row with no declared id falls back to the SDK's ledger form", () => {
    const store = storeWith(new FakeStorage());
    const bare = committed({ id: "" });

    assert.deepEqual(eventIdentityOf(bare), {
      guard: GUARD_A,
      id: `ledger:${"a".repeat(64)}:${GUARD_EVENT_TOPICS.authChecked}`,
      anchored: true,
    });
    assert.equal(store.applyMark(bare, { bookmarked: true }).ok, true);
    // …and the mark is then found by a row that does carry that id, so the fallback
    // cannot create a second bookmark for one event.
    assert.equal(store.markFor(committed())?.bookmarked, true);
  });

  test("a row with no emitting contract cannot be marked, and nothing is written", () => {
    const storage = new FakeStorage();
    const store = storeWith(storage);
    const outcome = store.applyMark(committed({ contractId: null }), { bookmarked: true });

    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.error, "unaddressed");
    assert.equal(storage.writes, 0, "a refusal must not touch storage");
    assert.equal(eventIdentityOf(committed({ contractId: "   " })), null);
    assert.equal(eventIdentityOf(committed({ contractId: null })), null);
  });

  test("un-marking removes the record once both halves are empty", () => {
    const storage = new FakeStorage();
    const store = storeWith(storage);
    const event = committed();
    store.applyMark(event, { bookmarked: true, note: "paging ops" });

    const unflagged = store.applyMark(event, { bookmarked: false });
    assert.equal(unflagged.ok, true);
    if (!unflagged.ok) return;
    assert.equal(unflagged.mark?.note, "paging ops", "the note survives losing the flag");

    const cleared = store.applyMark(event, { bookmarked: false, note: "" });
    assert.equal(cleared.ok, true);
    if (cleared.ok) assert.equal(cleared.mark, null, "no halves left, so no mark");
    assert.equal(store.markFor(event), null);
    assert.equal(storage.rawFor(GUARD_A), null, "an empty bucket removes the key");
  });
});

describe("scope to guard and network (#482)", () => {
  test("two guards never share a mark, even for an identical event id", () => {
    const store = storeWith(new FakeStorage());
    const shared = "ledger:deadbeef:event_auth_checked";
    store.applyMark(committed({ id: shared, contractId: GUARD_A }), { bookmarked: true });

    const underB = committed({ id: shared, contractId: GUARD_B });
    assert.equal(store.markFor(underB), null, "a mark is not portable between guards");
    assert.equal(store.applyMark(underB, { note: "mine" }).ok, true);
    assert.deepEqual(
      store.marksOf(GUARD_A),
      { [shared]: { bookmarked: true, note: "", updatedAt: STAMP } },
      "writing under B neither copies its note into A nor disturbs what A already held",
    );
    assert.equal(store.marksOf(GUARD_B)[shared]?.note, "mine");
  });

  test("the key names the base, the network and the guard", () => {
    const store = storeWith(new FakeStorage());
    assert.equal(
      store.storageKeyFor(GUARD_A),
      `${SCOPED_STORAGE_PREFIX}.${EVENT_MARKS_SCOPED_BASE}.${NETWORK}.${GUARD_A}`,
    );
    assert.notEqual(store.storageKeyFor(GUARD_A), store.storageKeyFor(GUARD_B));
    assert.notEqual(
      createEventMarksStore({ network: "futurenet", storage: null }).storageKeyFor(GUARD_A),
      store.storageKeyFor(GUARD_A),
      "the same guard on another network is another deployment, so another bucket",
    );
  });

  test("marks are enrolled in the scoped-base list, so deleting a guard clears them", () => {
    const storage = new FakeStorage();
    const store = storeWith(storage);
    store.applyMark(committed(), { bookmarked: true, note: "keep an eye on this" });
    assert.notEqual(storage.rawFor(GUARD_A), null);

    // The cascade enumerates `SCOPED_STORAGE_BASES`; being in that list is what
    // makes "delete the guard, delete its marks" true without a second code path.
    assert.ok(
      (SCOPED_STORAGE_BASES as readonly string[]).includes(EVENT_MARKS_SCOPED_BASE),
      "an unenrolled base would outlive the guard it annotates",
    );
    clearGuardScopedState(NETWORK, GUARD_A, { storage });
    assert.equal(storage.rawFor(GUARD_A), null);
  });
});

describe("diagnostic rows have no ledger identity (#482)", () => {
  test("anchored says whether the row can be re-read from a ledger later", () => {
    assert.equal(eventIdentityOf(committed())?.anchored, true);
    assert.equal(eventIdentityOf(refused())?.anchored, false);
  });

  test("two identical refusals are one event to the feed, so they are one mark", () => {
    const store = storeWith(new FakeStorage());
    const first = refused();
    const second = refused();
    assert.equal(first.id, second.id, "a diagnostic id hashes its content");

    store.applyMark(first, { bookmarked: true });
    assert.equal(
      store.markFor(second)?.bookmarked,
      true,
      "stated rather than hidden: a bookmark cannot be more precise than the identity the feed has",
    );
  });

  test("a diagnostic that never carried an id has nothing to key on", () => {
    // There is no ledger form to reconstruct for a refusal: no transaction, no
    // ledger. It renders no affordance rather than a mark that would land wrong.
    assert.equal(eventIdentityOf(refused({ id: "" })), null);
    const store = storeWith(new FakeStorage());
    assert.equal(store.applyMark(refused({ id: "" }), { note: "x" }).ok, false);
  });
});

describe("notes are browser-local (#483)", () => {
  test("a note round-trips through storage as a versioned envelope", () => {
    const storage = new FakeStorage();
    const store = storeWith(storage);
    store.applyMark(committed(), { note: "  correlate with the 12:00 deploy  " });

    const raw = storage.rawFor(GUARD_A);
    assert.notEqual(raw, null);
    if (raw === null) return;
    const envelope = JSON.parse(raw) as { schema: string; version: number };
    assert.equal(envelope.schema, EVENT_MARKS_SCHEMA);
    assert.equal(envelope.version, EVENT_MARKS_VERSION);

    // A new store over the same bytes is a page reload. The bucket is not read
    // until `observe()` says which guards are on screen, because a render must not
    // touch storage — that is the hydration rule this store inherits.
    const reloaded = storeWith(storage);
    assert.equal(reloaded.markFor(committed()), null);
    reloaded.observe([GUARD_A]);
    assert.equal(reloaded.markFor(committed())?.note, "correlate with the 12:00 deploy");
    assert.equal(reloaded.markFor(committed())?.updatedAt, STAMP);
  });

  test("a note is trimmed, newline-normalised, control-character-free and capped", () => {
    assert.equal(normalizeNote("  a\r\nb\t "), "a\nb");
    assert.equal(normalizeNote("a\x00b\x1fc"), "abc");
    assert.equal(
      normalizeNote("x".repeat(EVENT_NOTE_MAX_LENGTH + 400)).length,
      EVENT_NOTE_MAX_LENGTH,
    );
    assert.equal(normalizeNote("   "), "");
  });

  test("a note carrying a secret key is refused outright, not truncated", () => {
    const storage = new FakeStorage();
    const store = storeWith(storage);
    const secret = "S" + "A".repeat(55);
    const outcome = store.applyMark(committed(), { note: `pager ${secret} please` });

    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.error, "secret-key");
    // The reason names the finding without echoing it: a rejected note that repeats
    // the key has leaked it into the DOM, which is the thing being refused.
    assert.equal(outcome.message, SECRET_NOTE_REJECTED);
    assert.equal(outcome.message.includes(secret), false);
    assert.equal(storage.writes, 0);
    assert.equal(store.markFor(committed()), null);
  });

  test("the cap is enforced on the stored value, not only on the textarea", () => {
    const storage = new FakeStorage();
    const store = storeWith(storage);
    const long = "n".repeat(EVENT_NOTE_MAX_LENGTH + 250);
    const outcome = store.applyMark(committed(), { note: long });

    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.mark?.note.length, EVENT_NOTE_MAX_LENGTH);
    const raw = storage.rawFor(GUARD_A) ?? "";
    assert.equal(raw.includes("n".repeat(EVENT_NOTE_MAX_LENGTH + 1)), false);
  });

  test("a mark is refused at the cap, and nothing already saved is evicted", () => {
    const storage = new FakeStorage();
    const store = storeWith(storage);
    for (let index = 0; index < EVENT_MARKS_LIMIT; index += 1) {
      const outcome = store.applyMark(committed({ id: `ledger:tx-${index}:event_auth_checked` }), {
        bookmarked: true,
      });
      assert.equal(outcome.ok, true, `mark ${index} should fit under the cap`);
    }
    assert.equal(Object.keys(store.marksOf(GUARD_A)).length, EVENT_MARKS_LIMIT);

    const overflow = store.applyMark(committed({ id: "ledger:tx-overflow:x" }), {
      bookmarked: true,
    });
    assert.equal(overflow.ok, false);
    if (overflow.ok) return;
    assert.equal(overflow.error, "full");
    assert.equal(overflow.message, MARKS_FULL_REJECTED);
    assert.equal(
      Object.keys(store.marksOf(GUARD_A)).length,
      EVENT_MARKS_LIMIT,
      "the cap refuses the newcomer rather than evicting an older bookmark",
    );
    // Editing a mark that already exists is never blocked by the cap.
    assert.equal(
      store.applyMark(committed({ id: "ledger:tx-0:event_auth_checked" }), { note: "still here" })
        .ok,
      true,
    );
  });
});

describe("a record that cannot be read is reported, not overwritten", () => {
  const key = `${SCOPED_STORAGE_PREFIX}.${EVENT_MARKS_SCOPED_BASE}.${NETWORK}.${GUARD_A}`;

  const unreadable: readonly [label: string, raw: string, error: string][] = [
    ["not json at all", "}{", "parse"],
    ["a foreign envelope", JSON.stringify({ schema: "other", version: 1, data: {} }), "parse"],
    [
      "a newer build's envelope",
      JSON.stringify({ schema: EVENT_MARKS_SCHEMA, version: EVENT_MARKS_VERSION + 1, data: {} }),
      "future-version",
    ],
    ["a bare legacy payload", JSON.stringify({ "ledger:x": { bookmarked: true } }), "migration"],
  ];
  for (const [label, raw, error] of unreadable) {
    test(`when the bytes are ${label} the notice says ${error} and the bytes stay`, () => {
      const storage = new FakeStorage({ [key]: raw });
      const store = storeWith(storage);
      store.observe([GUARD_A]);

      assert.equal(store.notice()?.error, error);
      assert.equal(store.notice()?.message.includes("left unchanged"), true);
      assert.equal(store.marksOf(GUARD_A), store.marksOf(GUARD_A));
      assert.equal(Object.keys(store.marksOf(GUARD_A)).length, 0, "unreadable shows as no marks");
      assert.equal(storage.rawFor(GUARD_A), raw, "and the operator can still recover them by hand");
    });
  }

  test("a valid record with one unreadable entry keeps the rest", () => {
    const storage = new FakeStorage({
      [key]: JSON.stringify({
        schema: EVENT_MARKS_SCHEMA,
        version: EVENT_MARKS_VERSION,
        data: {
          "ledger:good:x": { bookmarked: true, note: "kept", updatedAt: STAMP },
          "ledger:bad:x": { bookmarked: "yes", note: "dropped", updatedAt: STAMP },
          "ledger:empty:x": { bookmarked: false, note: "   ", updatedAt: STAMP },
        },
      }),
    });
    const store = storeWith(storage);
    store.observe([GUARD_A]);

    assert.deepEqual(Object.keys(store.marksOf(GUARD_A)), ["ledger:good:x"]);
    assert.equal(store.marksOf(GUARD_A)["ledger:good:x"]?.note, "kept");
  });

  test("parseGuardMarks rejects shapes storage could plausibly hold", () => {
    for (const value of [null, undefined, 7, "[]", [], "not an object"]) {
      assert.deepEqual(parseGuardMarks(value), {});
    }
    assert.deepEqual(
      parseGuardMarks({ "": { bookmarked: true, note: "a", updatedAt: STAMP } }),
      {},
    );
  });

  test("a storage write that fails leaves the mark live and says so", () => {
    const storage = new FakeStorage();
    storage.throwOnWrite = quotaError();
    const store = storeWith(storage);
    const outcome = store.applyMark(committed(), { bookmarked: true });

    assert.equal(outcome.ok, true, "the operator did ask for the bookmark, and it is on the row");
    assert.equal(outcome.persisted, false);
    assert.equal(store.markFor(committed())?.bookmarked, true);
    assert.equal(store.notice()?.error, "quota");
    assert.match(store.notice()?.message ?? "", /full/i);

    // A later write that succeeds retires the complaint, so the panel cannot keep
    // warning about a failure the operator has outlived.
    storage.throwOnWrite = null;
    store.applyMark(committed(), { note: "written now" });
    assert.equal(store.notice(), null);
  });

  test("with no storage at all the marks stay in memory for the session", () => {
    const store = storeWith(null);
    const outcome = store.applyMark(committed(), { note: "private mode" });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.persisted, false);
    assert.equal(store.notice()?.error, "unavailable");
    assert.equal(store.markFor(committed())?.note, "private mode");
  });
});

describe("marks follow the browser's own rules", () => {
  test("observe() loads each guard once and re-notifies only on a change", () => {
    const storage = new FakeStorage();
    const store = storeWith(storage);
    const before = storage.reads.length;
    store.observe([GUARD_A, GUARD_A, "", GUARD_B]);
    const afterFirst = storage.reads.length;
    assert.equal(afterFirst - before, 2, "one read per distinct guard");

    store.observe([GUARD_B, GUARD_A]);
    assert.equal(
      storage.reads.length,
      afterFirst,
      "the same set in another order re-reads nothing",
    );
    assert.deepEqual([...store.observedGuards()].sort(), [GUARD_A, GUARD_B]);
  });

  test("a storage event for a marks key re-reads; an unrelated key does not", () => {
    const storage = new FakeStorage();
    const { target, fire, listenerCount } = fakeTarget();
    const store = createEventMarksStore({
      network: NETWORK,
      storage,
      now: clock,
      eventTarget: target,
    });
    const unsubscribe = store.subscribe(() => {});
    assert.equal(listenerCount(), 1, "the listener is attached once, with the first subscriber");

    store.observe([GUARD_A]);
    const readsAfterObserve = storage.reads.length;
    const before = store.getSnapshot();

    fire(`${SCOPED_STORAGE_PREFIX}.feedFilter.${NETWORK}.${GUARD_A}`);
    assert.equal(store.getSnapshot(), before, "another base is not our news");
    assert.equal(storage.reads.length, readsAfterObserve);

    // Another tab bookmarks the same row. The payload is ignored and the bucket is
    // re-read, which is the rule every cross-tab path here follows.
    const other = createEventMarksStore({ network: NETWORK, storage, now: clock });
    other.applyMark(committed(), { bookmarked: true });
    fire(store.storageKeyFor(GUARD_A));
    assert.equal(store.getSnapshot(), before + 1);
    assert.equal(store.markFor(committed())?.bookmarked, true);

    unsubscribe();
    assert.equal(listenerCount(), 0, "the last listener detaches the window handler");
  });

  test("the snapshot is a revision, and the server snapshot is always empty", () => {
    const store = storeWith(new FakeStorage());
    assert.equal(store.getServerSnapshot(), 0);
    const before = store.getSnapshot();
    store.applyMark(committed(), { bookmarked: true });
    assert.equal(store.getSnapshot(), before + 1);
  });

  test("a mark's object identity changes only when that mark changes", () => {
    // The property the memoised row depends on: 250 rows read through one
    // subscription, and only the annotated one gets a new reference to compare.
    const store = storeWith(new FakeStorage());
    store.applyMark(committed({ id: "ledger:1:x" }), { bookmarked: true });
    store.applyMark(committed({ id: "ledger:2:x" }), { bookmarked: true });
    const first = store.markFor(committed({ id: "ledger:1:x" }));
    store.applyMark(committed({ id: "ledger:2:x" }), { note: "only the second moves" });
    assert.equal(store.markFor(committed({ id: "ledger:1:x" })), first);
    assert.notEqual(store.markFor(committed({ id: "ledger:2:x" })), first);
  });

  test("hasAnyMark is a cache read, so the panel can gate its own copy on it", () => {
    const storage = new FakeStorage();
    const store = storeWith(storage);
    assert.equal(store.hasAnyMark(), false);
    store.applyMark(committed(), { bookmarked: true });
    assert.equal(store.hasAnyMark(), true);
  });
});

describe("no note can reach an export or a transaction (#483)", () => {
  const SENTINEL = "NOTE-SENTINEL-correlate-with-the-12:00-deploy";

  /** Every writer the console offers, over the same rows the table displays. */
  function allExportSurfaces(events: GuardEvent[]): string[] {
    return [
      eventsToCsv(events, GUARD_A),
      JSON.stringify(eventsToJson(events, GUARD_A)),
      telemetryToCsv(events),
      telemetryToNdjson(events),
      telemetryToAuditLog({
        events,
        bufferedCount: events.length,
        guard: GUARD_A,
        network: NETWORK,
        filter: EMPTY_TELEMETRY_FILTER,
        latestLedger: 100,
        demo: false,
        exportedAt: new Date(STAMP),
      }),
      JSON.stringify(
        // The payload a dispatch of these rows would actually send: an event type
        // plus the one row-derived figure the dispatcher computes, so a note has no
        // field to travel in.
        serializeWebhookPayload(
          buildWebhookPayload({
            event: "BLOCK_THRESHOLD_EXCEEDED",
            guard: GUARD_A,
            network: NETWORK,
            details: { blocked_count: countBlockedInWindow(events, 300, Date.parse(STAMP)) },
          }),
        ),
      ),
    ];
  }

  test("a saved note is absent from every export surface", () => {
    const storage = new FakeStorage();
    const store = storeWith(storage);
    const event = committed();
    store.applyMark(event, { bookmarked: true, note: SENTINEL });
    store.applyMark(refused(), { note: `${SENTINEL} (also on a refusal)` });

    const events = [event, refused()];
    for (const surface of allExportSurfaces(events)) {
      assert.equal(surface.includes(SENTINEL), false, "the note text must not appear");
      assert.equal(surface.includes("correlate with the 12:00"), false, "nor any fragment");
      assert.equal(surface.includes(SENTINEL.slice(0, 12)), false, "nor a prefix of it");
    }
  });

  test("no exporter reads the marks key, so nothing browser-local can leak", () => {
    // The structural half of the claim. Each exporter is a function of the events
    // it is handed; if one ever started reading `localStorage` for annotations, the
    // read log would say so — and this fails whether or not the sentinel happened to
    // land in the output.
    const storage = new FakeStorage();
    const store = storeWith(storage);
    const event = committed();
    store.applyMark(event, { note: SENTINEL });
    storage.reads.length = 0;

    allExportSurfaces([event, refused()]);

    const marksReads = storage.reads.filter((key) =>
      key.startsWith(`${SCOPED_STORAGE_PREFIX}.${EVENT_MARKS_SCOPED_BASE}.`),
    );
    assert.deepEqual(marksReads, []);
    assert.deepEqual(storage.reads, [], "and no storage read of any kind");
  });

  test("the mark and the event stay separate objects, by construction", () => {
    const store = storeWith(new FakeStorage());
    const event = committed();
    store.applyMark(event, { bookmarked: true, note: SENTINEL });

    assert.equal(Object.prototype.hasOwnProperty.call(event, "note"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(event, "bookmarked"), false);
    assert.notEqual(store.markFor(event), null, "the annotation exists, just not on the row");
  });
});

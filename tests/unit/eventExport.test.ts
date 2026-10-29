import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  EVENT_EXPORT_COLUMNS,
  EVENT_EXPORT_SCHEMA_VERSION,
  eventToExportRow,
  eventsToCsv,
  eventsToJson,
  exportFilename,
} from "../../lib/guard/eventExport.ts";
import { explainReason } from "stellar-agent-guard-sdk";
import type { GuardEvent } from "stellar-agent-guard-sdk";
import authCheckedVocabulary from "../../tests/fixtures/auth-checked-vocabulary.json";

/** A 56-character Stellar contract id starting with the test's prefix. */
const GUARD = "CAPADGEK".padEnd(56, "A");

function ledgerEvent(overrides: Partial<GuardEvent> = {}): GuardEvent {
  return {
    id: `ledger:${"aa11bb22cc33".padEnd(64, "0")}:event_auth_checked`,
    kind: "auth_checked",
    topic: "event_auth_checked",
    source: "ledger",
    stream: "committed",
    contractId: GUARD,
    ledger: 4820001,
    observedAt: null,
    ledgerClosedAt: "2026-09-24T10:00:00Z",
    transactionHash: "aa11bb22cc33".padEnd(64, "0"),
    decision: { result: "allowed", reason: null, source: "ledger" },
    data: { at: "2026-09-24T10:00:00Z" },
    ...overrides,
  };
}

test("rows flatten guard events: every cell is a string, missing values are empty", () => {
  const row = eventToExportRow(ledgerEvent(), GUARD);
  assert.deepEqual(Object.keys(row), [...EVENT_EXPORT_COLUMNS]);
  for (const value of Object.values(row)) assert.equal(typeof value, "string");
  assert.equal(row.schema_version, String(EVENT_EXPORT_SCHEMA_VERSION));
  assert.equal(row.guard, GUARD);
  assert.equal(row.ledger, "4820001"); // number in, string out — no coercion
  assert.equal(row.ledger_closed_at, "2026-09-24T10:00:00Z");
  assert.equal(row.decision, "allowed");
  assert.equal(row.reason, ""); // allowed decisions carry no reason
  assert.equal(row.reason_label, ""); // allowed decisions carry no reason label
});

// New test: vocabulary fixture is comprehensive and covers all known reasons
test("vocabulary fixture covers all auth_checked reasons", () => {
  const allReasons = authCheckedVocabulary.known_reasons;
  // Verify all known reasons are present in the fixture
  assert(allReasons.length > 0, "should have known reasons");
  // Verify the coverage claim from the fixture
  assert(authCheckedVocabulary.coverage.all_reasons_covered, "should cover all reasons");
});

// New test: blocked decisions use vocabulary reasons
test("blocked decisions carry the raw reason symbol and the SDK's human label", () => {
  const blocked = ledgerEvent({
    source: "diagnostic",
    ledger: null,
    ledgerClosedAt: null,
    transactionHash: null,
    decision: { result: "blocked", reason: "per_tx_cap_exceeded", source: "diagnostic" },
  });
  const row = eventToExportRow(blocked, GUARD);
  assert.equal(row.decision, "blocked");
  assert.equal(row.reason, "per_tx_cap_exceeded");
  assert.equal(row.reason_label, explainReason("per_tx_cap_exceeded"));
  assert.ok(row.reason_label.length > 0, "the SDK supplies a non-empty explanation");
  assert.equal(row.ledger, ""); // diagnostic events have no ledger commitment
  assert.equal(row.transaction_hash, "");
});

// Test that reason_label matches the vocabulary explanation
test("reason_label matches vocabulary explanation for all known reasons", () => {
  const blocked = ledgerEvent({
    source: "diagnostic",
    decision: { result: "blocked", reason: "admin_frozen", source: "diagnostic" },
  });
  const row = eventToExportRow(blocked, GUARD);
  assert.equal(row.reason_label, explainReason("admin_frozen"));
  assert.ok(row.reason_label.length > 0, "reason label should be non-empty");
});

test("non-auth events export with an empty decision pair", () => {
  const heartbeat = ledgerEvent({ kind: "heartbeat", topic: "heartbeat", decision: null });
  const row = eventToExportRow(heartbeat, GUARD);
  assert.equal(row.decision, "");
  assert.equal(row.reason, "");
  assert.equal(row.reason_label, "");
  assert.equal(row.kind, "heartbeat");
});

test("doc-sync: docs/export-schema.md documents every column, append-only, and the version", () => {
  const doc = readFileSync("docs/export-schema.md", "utf8");
  for (const column of EVENT_EXPORT_COLUMNS) {
    assert.ok(doc.includes(`\`${column}\``), `the doc documents \`${column}\` in backticks`);
  }
  assert.match(doc, /append-only/i, "the doc states the append-only compatibility rule");
  assert.match(doc, /schema_version/i, "the doc mentions the schema_version column");
  assert.ok(
    doc.includes(String(EVENT_EXPORT_SCHEMA_VERSION)),
    "the doc states the current schema version",
  );
});

test("CSV: header row is the column list, rows follow the feed's order", () => {
  const events = [
    ledgerEvent({ kind: "heartbeat", topic: "heartbeat", decision: null }),
    ledgerEvent({
      source: "diagnostic",
      decision: { result: "blocked", reason: "per_tx_cap_exceeded", source: "diagnostic" },
    }),
    ledgerEvent({
      source: "diagnostic",
      decision: { result: "blocked", reason: "admin_frozen", source: "diagnostic" },
    }),
  ];
  const csv = eventsToCsv(events, GUARD);
  assert.equal(csv.charCodeAt(0), 0xfeff, "BOM first, then the header row");
  const lines = csv.slice(1).split("\n");
  assert.equal(lines[0], EVENT_EXPORT_COLUMNS.join(","));
  assert.match(lines[2]!, /per_tx_cap_exceeded/);
  assert.match(lines[3]!, /admin_frozen/);
});

test("CSV is BOM-prefixed (UTF-8 bytes EF BB BF) so Excel opens it as UTF-8", () => {
  const csv = eventsToCsv([ledgerEvent()], GUARD);
  assert.equal(csv.charCodeAt(0), 0xfeff, "the string starts with U+FEFF");
  const bytes = new TextEncoder().encode(csv);
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf]);
});

test("CSV quotes cells per RFC 4180 (commas, quotes, newlines) and doubles quotes", () => {
  // The reason column is a closed union of contract symbols (sdk 0.1.1), so
  // the hostile string lives in `topic`, the one free-text column, to pin the
  // same RFC 4180 quoting rule.
  const chatty = ledgerEvent({ topic: 'paused, "test"' });
  const csv = eventsToCsv([chatty], GUARD);
  const topicCell = csv.slice(1).split("\n")[1]!.split(",").slice(2, 4).join(",");
  assert.ok(
    topicCell.includes('"paused, ""test"""'),
    `the topic cell is quoted with doubled inner quotes, got: ${topicCell}`,
  );
});

test("JSON export serialises with insertion-ordered keys (schemaVersion → columns → guard → rows)", () => {
  const json = JSON.stringify(eventsToJson([ledgerEvent()], GUARD));
  const at = (needle: string) => json.indexOf(needle);
  const order = ["schemaVersion", "columns", "guard", "rows"];
  for (let i = 1; i < order.length; i += 1) {
    assert.ok(
      at(`"${order[i - 1]}"`) < at(`"${order[i]}"`),
      `${order[i - 1]} precedes ${order[i]}`,
    );
  }
  const parsed = JSON.parse(json) as {
    schemaVersion: number;
    columns: string[];
    guard: string;
    rows: { schema_version: string }[];
  };
  assert.equal(parsed.schemaVersion, EVENT_EXPORT_SCHEMA_VERSION);
  assert.deepEqual(parsed.columns, [...EVENT_EXPORT_COLUMNS]);
  assert.equal(parsed.guard, GUARD);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0]!.schema_version, String(EVENT_EXPORT_SCHEMA_VERSION));
});

test("filename is deterministic: guard prefix, UTC day, row count, extension", () => {
  const name = exportFilename(GUARD, "csv", 42, Date.parse("2026-09-24T10:00:00Z"));
  assert.match(name, /^guard-events-CAPADGEK-2026-09-24-42\.csv$/);
  assert.match(
    exportFilename(GUARD, "json", 42, Date.parse("2026-09-24T10:00:00Z")),
    /\.[jt]sons?$/,
  );
});

test("an empty feed exports a header-only CSV and an empty-rows JSON", () => {
  const csv = eventsToCsv([], GUARD);
  assert.equal(csv, `\uFEFF${EVENT_EXPORT_COLUMNS.join(",")}\n`);
  const json = eventsToJson([], GUARD);
  assert.deepEqual(json.rows, []);
  assert.equal(json.columns.length, EVENT_EXPORT_COLUMNS.length);
});

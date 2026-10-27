import assert from "node:assert/strict";
import { test } from "node:test";
import {
  exportAssetCapsCsv,
  exportAssetCapsJson,
  mergeAssetCapOverrides,
  parseAssetCapsCsv,
  parseAssetCapsJson,
  previewAssetCapImport,
  validateAssetCapOverrides,
  type AssetCapOverride,
} from "../../lib/guard/assetCapsCsv.ts";

const ASSET = "CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB";
const ASSET_TWO = "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44";

const rows: AssetCapOverride[] = [
  { assetContractAddress: ASSET, maxCapStroops: "1000000", symbol: "USDC" },
  { assetContractAddress: ASSET_TWO, maxCapStroops: "42", symbol: "EUR" },
];

test("CSV parsing validates addresses and positive stroop caps", () => {
  const source = exportAssetCapsCsv(rows);
  assert.deepEqual(parseAssetCapsCsv(source), rows);
  assert.throws(() => parseAssetCapsCsv(source.replace("42,EUR", "0,EUR")), /positive integer/);
  assert.throws(() => parseAssetCapsCsv(source.replace(ASSET, "not-an-address")), /valid Stellar/);
});

test("CSV parsing rejects malformed rows, duplicate addresses, and bad headers", () => {
  assert.throws(() => parseAssetCapsCsv("wrong,header,symbol\n"), /Expected header/);
  assert.throws(
    () => parseAssetCapsCsv(`${exportAssetCapsCsv(rows)}${ASSET},7,USD\n`),
    /duplicate/,
  );
  assert.throws(
    () => parseAssetCapsCsv(`${exportAssetCapsCsv(rows)}${ASSET},7\n`),
    /three columns/,
  );
});

test("JSON round trips through the same validated row model", () => {
  assert.deepEqual(parseAssetCapsJson(exportAssetCapsJson(rows)), rows);
  assert.throws(() => parseAssetCapsJson('{"not":"an array"}'), /array/);
});

test("asset-cap overrides reject values outside the XDR i128 range", () => {
  const invalid = [{ ...rows[0]!, maxCapStroops: "170141183460469231731687303715884105728" }];
  assert.match(validateAssetCapOverrides(invalid)[0] ?? "", /supported i128 range/);
  assert.throws(() => parseAssetCapsCsv(exportAssetCapsCsv(invalid)), /supported i128 range/);
});

test("import merging marks additions and updates without dropping existing rows", () => {
  const result = mergeAssetCapOverrides(rows, [
    { ...rows[0]!, maxCapStroops: "2000000" },
    { assetContractAddress: ASSET_TWO, maxCapStroops: "42", symbol: "EUR" },
  ]);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0]?.maxCapStroops, "2000000");
  assert.equal(result.changes[ASSET], "updated");
  assert.equal(result.changes[ASSET_TWO], undefined);
});

const THREE_COLUMN_HEADER = "asset_contract_address,max_cap_stroops,symbol\n";

test("CSV preview reports accepted rows with before/after state and applies nothing", () => {
  const current: AssetCapOverride[] = [rows[0]!];
  const snapshot = structuredClone(current);
  const source = THREE_COLUMN_HEADER + `${ASSET},2000000,USDC\n` + `${ASSET_TWO},42,EUR\n`;

  const result = previewAssetCapImport(current, source, "csv");
  assert.ok(result.ok);
  const preview = result.preview;

  assert.deepEqual(preview.totals, {
    accepted: 2,
    rejected: 0,
    added: 1,
    updated: 1,
    unchanged: 0,
    duplicates: 0,
  });
  assert.deepEqual(preview.changes, { [ASSET]: "updated", [ASSET_TWO]: "added" });
  assert.deepEqual(preview.accepted[0]?.before, rows[0]);
  assert.equal(preview.accepted[0]?.change, "updated");
  assert.equal(preview.accepted[0]?.rowNumber, 2);
  assert.equal(preview.accepted[0]?.row.maxCapStroops, "2000000");
  assert.equal(preview.accepted[1]?.before, null);
  assert.equal(preview.accepted[1]?.change, "added");

  // The merge is a proposal only: the caller's draft is untouched.
  assert.deepEqual(current, snapshot);
  assert.deepEqual(preview.mergedRows, [{ ...rows[0]!, maxCapStroops: "2000000" }, rows[1]!]);
});

test("CSV preview marks an identical row unchanged instead of claiming an update", () => {
  const result = previewAssetCapImport(rows, exportAssetCapsCsv(rows), "csv");
  assert.ok(result.ok);
  assert.deepEqual(
    result.preview.accepted.map((entry) => entry.change),
    ["unchanged", "unchanged"],
  );
  assert.deepEqual(result.preview.changes, {});
  assert.equal(result.preview.totals.unchanged, 2);
});

test("CSV preview keeps good rows and reports every bad row by line", () => {
  const source = [
    THREE_COLUMN_HEADER.trimEnd(),
    `${ASSET},1000000,USDC`,
    "not-an-address,7,USD",
    `${ASSET_TWO},0,EUR`,
    `${ASSET_TWO},9`,
    `${ASSET_TWO},9,`,
  ].join("\n");

  const result = previewAssetCapImport([], source, "csv");
  assert.ok(result.ok);
  const preview = result.preview;

  assert.equal(preview.totals.accepted, 1);
  assert.equal(preview.totals.rejected, 4);
  assert.deepEqual(
    preview.rejected.map((entry) => entry.rowNumber),
    [3, 4, 5, 6],
  );
  assert.match(preview.rejected[0]?.errors.join(" ") ?? "", /not a valid Stellar contract/);
  assert.match(preview.rejected[1]?.errors.join(" ") ?? "", /positive integer/);
  assert.match(preview.rejected[2]?.errors.join(" ") ?? "", /three columns/);
  assert.match(preview.rejected[3]?.errors.join(" ") ?? "", /symbol is required/);
  assert.deepEqual(preview.mergedRows, [rows[0]!]);
});

test("CSV preview names duplicate assets and keeps the first accepted row", () => {
  const source =
    THREE_COLUMN_HEADER + `${ASSET},100,USDC\n` + `${ASSET},200,USDC\n` + `${ASSET},300,USDC\n`;
  const result = previewAssetCapImport([], source, "csv");
  assert.ok(result.ok);

  assert.equal(result.preview.totals.accepted, 1);
  assert.equal(result.preview.totals.rejected, 2);
  assert.deepEqual(result.preview.duplicateAssets, [
    { rowNumber: 3, assetContractAddress: ASSET, firstRowNumber: 2 },
    { rowNumber: 4, assetContractAddress: ASSET, firstRowNumber: 2 },
  ]);
  assert.match(result.preview.rejected[0]?.errors.join(" ") ?? "", /duplicate asset contract/);
  assert.equal(result.preview.mergedRows[0]?.maxCapStroops, "100");
});

test("a rejected first mention does not block a later valid row for the same asset", () => {
  const source = THREE_COLUMN_HEADER + `${ASSET},0,USDC\n` + `${ASSET},100,USDC\n`;
  const result = previewAssetCapImport([], source, "csv");
  assert.ok(result.ok);
  assert.equal(result.preview.totals.accepted, 1);
  assert.equal(result.preview.totals.rejected, 1);
  assert.equal(result.preview.mergedRows[0]?.maxCapStroops, "100");
});

test("file-level preview errors never stage a partial import", () => {
  const empty = previewAssetCapImport(rows, "", "csv");
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.match(empty.error, /empty/);

  const badHeader = previewAssetCapImport(rows, "wrong,header,symbol\n", "csv");
  assert.equal(badHeader.ok, false);
  if (!badHeader.ok) assert.match(badHeader.error, /Expected header/);

  const badJson = previewAssetCapImport(rows, "{not json", "json");
  assert.equal(badJson.ok, false);
  if (!badJson.ok) assert.match(badJson.error, /not valid JSON/);

  const notArray = previewAssetCapImport(rows, '{"rows":[]}', "json");
  assert.equal(notArray.ok, false);
  if (!notArray.ok) assert.match(notArray.error, /array/);
});

test("a header-only file is a valid empty preview, not a malformed one", () => {
  const result = previewAssetCapImport(rows, THREE_COLUMN_HEADER, "csv");
  assert.ok(result.ok);
  assert.equal(result.preview.totals.accepted, 0);
  assert.equal(result.preview.totals.rejected, 0);
  assert.deepEqual(result.preview.mergedRows, rows);
});

test("JSON preview rejects bad rows individually and supports updates", () => {
  const source = JSON.stringify([
    { asset_contract_address: ASSET, max_cap_stroops: "2000000", symbol: "USDC" },
    { asset_contract_address: "not-an-address", max_cap_stroops: "1", symbol: "BAD" },
    "not-an-object",
  ]);
  const result = previewAssetCapImport(rows, source, "json");
  assert.ok(result.ok);
  assert.equal(result.preview.totals.accepted, 1);
  assert.equal(result.preview.totals.rejected, 2);
  assert.deepEqual(
    result.preview.rejected.map((entry) => entry.rowNumber),
    [2, 3],
  );
  assert.match(result.preview.rejected[1]?.errors.join(" ") ?? "", /must be an object/);
  assert.equal(result.preview.accepted[0]?.change, "updated");
});

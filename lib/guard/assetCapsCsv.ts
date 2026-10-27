import { Address } from "@stellar/stellar-sdk";

export interface AssetCapOverride {
  assetContractAddress: string;
  maxCapStroops: string;
  symbol: string;
}

export type AssetCapChange = "added" | "updated";

export interface AssetCapImport {
  rows: AssetCapOverride[];
  changes: Record<string, AssetCapChange>;
}

/** The supported bulk-input formats. */
export type AssetCapPreviewFormat = "csv" | "json";

/** How one accepted preview row would change the current draft. */
export type AssetCapPreviewChange = "added" | "updated" | "unchanged";

/** A row that passed validation and is safe to apply on confirmation. */
export interface AssetCapPreviewAccepted {
  /** 1-based source row. For CSV the header is row 1, so data starts at row 2. */
  rowNumber: number;
  row: AssetCapOverride;
  change: AssetCapPreviewChange;
  /** The row currently in the draft for this contract, when one exists. */
  before: AssetCapOverride | null;
}

/** A row that was rejected, with every reason found for it. */
export interface AssetCapPreviewRejected {
  rowNumber: number;
  /** The source cells, joined for display. Never used to build the draft. */
  raw: string;
  errors: string[];
}

/** A later row naming an asset an earlier accepted row already defined. */
export interface AssetCapDuplicateAsset {
  rowNumber: number;
  assetContractAddress: string;
  firstRowNumber: number;
}

/**
 * A complete, side-effect-free reading of an import file.
 *
 * `mergedRows` is the draft the file *would* produce. Nothing in the form is
 * touched until the operator confirms this preview, which is the point: a
 * malformed row must be catchable before a policy write is staged.
 */
export interface AssetCapImportPreview {
  format: AssetCapPreviewFormat;
  accepted: AssetCapPreviewAccepted[];
  rejected: AssetCapPreviewRejected[];
  duplicateAssets: AssetCapDuplicateAsset[];
  /** The current draft with every accepted row applied, in source order. */
  mergedRows: AssetCapOverride[];
  /** Only rows that actually change something, keyed by contract address. */
  changes: Record<string, AssetCapChange>;
  totals: {
    accepted: number;
    rejected: number;
    added: number;
    updated: number;
    unchanged: number;
    duplicates: number;
  };
}

export type AssetCapPreviewResult =
  { ok: true; preview: AssetCapImportPreview } | { ok: false; error: string };

const HEADERS = ["asset_contract_address", "max_cap_stroops", "symbol"] as const;
const MAX_STROOP_CAP = (1n << 127n) - 1n;

interface CsvRecordEntry {
  record: string[];
  /** The 1-based line the record starts on. */
  line: number;
}

interface PreviewSourceRow {
  rowNumber: number;
  raw: string;
  /** `null` when the source row is not shaped like three string cells. */
  values: string[] | null;
  shapeError: string | null;
}

export function parseAssetCapsCsv(source: string): AssetCapOverride[] {
  const entries = parseCsvRecordEntries(source);
  if (entries.length === 0) throw new Error("The file is empty");

  const header = entries.shift();
  if (
    !header ||
    header.record.length !== HEADERS.length ||
    header.record.some((value, index) => value !== HEADERS[index])
  ) {
    throw new Error(`Expected header: ${HEADERS.join(",")}`);
  }
  return validateRows(
    entries.map((entry) => entry.record),
    "CSV",
  );
}

export function parseAssetCapsJson(source: string): AssetCapOverride[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("The JSON file is not valid JSON");
  }
  if (!Array.isArray(parsed)) throw new Error("JSON must contain an array of asset overrides");
  const records = parsed.map((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error(`JSON row ${index + 1} must be an object`);
    }
    const value = row as Record<string, unknown>;
    return [value.asset_contract_address, value.max_cap_stroops, value.symbol].map((field) =>
      typeof field === "string" ? field : String(field ?? ""),
    );
  });
  return validateRows(records, "JSON");
}

/**
 * Parse and validate an entire import without touching the draft.
 *
 * Unlike `parseAssetCapsCsv` / `parseAssetCapsJson`, this never stops at the
 * first bad row and never throws for row-level problems: a file with one bad
 * row still shows the operator every good row it would add or update, plus the
 * exact rejection. Only a file that cannot be read at all (empty, wrong header,
 * invalid JSON, non-array JSON) is a file-level error.
 */
export function previewAssetCapImport(
  current: readonly AssetCapOverride[],
  source: string,
  format: AssetCapPreviewFormat,
): AssetCapPreviewResult {
  let rows: PreviewSourceRow[];

  if (format === "csv") {
    let entries: CsvRecordEntry[];
    try {
      entries = parseCsvRecordEntries(source);
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
    if (entries.length === 0) return { ok: false, error: "The file is empty" };

    const header = entries.shift();
    if (
      !header ||
      header.record.length !== HEADERS.length ||
      header.record.some((value, index) => value !== HEADERS[index])
    ) {
      return { ok: false, error: `Expected header: ${HEADERS.join(",")}` };
    }
    rows = entries.map((entry) => ({
      rowNumber: entry.line,
      raw: entry.record.map((value) => value.trim()).join(","),
      values: entry.record,
      shapeError:
        entry.record.length !== HEADERS.length
          ? `CSV row ${entry.line} must have three columns`
          : null,
    }));
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch {
      return { ok: false, error: "The JSON file is not valid JSON" };
    }
    if (!Array.isArray(parsed)) {
      return { ok: false, error: "JSON must contain an array of asset overrides" };
    }
    rows = parsed.map((row, index) => {
      const rowNumber = index + 1;
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        return {
          rowNumber,
          raw: boundedRaw(row),
          values: null,
          shapeError: `JSON row ${rowNumber} must be an object`,
        };
      }
      const value = row as Record<string, unknown>;
      return {
        rowNumber,
        raw: boundedRaw(row),
        values: [value.asset_contract_address, value.max_cap_stroops, value.symbol].map((field) =>
          typeof field === "string" ? field : String(field ?? ""),
        ),
        shapeError: null,
      };
    });
  }

  const accepted: AssetCapPreviewAccepted[] = [];
  const rejected: AssetCapPreviewRejected[] = [];
  const duplicateAssets: AssetCapDuplicateAsset[] = [];
  const mergedRows = current.map((row) => ({ ...row }));
  const changes: Record<string, AssetCapChange> = {};

  for (const sourceRow of rows) {
    const errors: string[] = [];
    let parsedRow: AssetCapOverride | null = null;

    if (sourceRow.shapeError !== null) {
      errors.push(sourceRow.shapeError);
    } else if (sourceRow.values !== null) {
      const [assetContractAddress, maxCapStroops, symbol] = sourceRow.values.map((value) =>
        value.trim(),
      ) as [string, string, string];
      const label = `${format.toUpperCase()} row ${sourceRow.rowNumber}`;

      if (!assetContractAddress || !isAddress(assetContractAddress)) {
        errors.push(`${label}: asset_contract_address is not a valid Stellar contract address`);
      }
      if (!maxCapStroops || !/^\d+$/.test(maxCapStroops) || BigInt(maxCapStroops) <= 0n) {
        errors.push(`${label}: max_cap_stroops must be a positive integer`);
      }
      if (!symbol) errors.push(`${label}: symbol is required`);

      // Only a fully valid row claims its address, so a later valid row may
      // still define an asset whose first mention was rejected.
      if (errors.length === 0) {
        const first = accepted.find(
          (entry) => entry.row.assetContractAddress === assetContractAddress,
        );
        if (first) {
          duplicateAssets.push({
            rowNumber: sourceRow.rowNumber,
            assetContractAddress,
            firstRowNumber: first.rowNumber,
          });
          errors.push(
            `${label}: duplicate asset contract address (first accepted on row ${first.rowNumber})`,
          );
        } else {
          parsedRow = { assetContractAddress, maxCapStroops, symbol };
        }
      }
    }

    if (parsedRow === null) {
      rejected.push({ rowNumber: sourceRow.rowNumber, raw: sourceRow.raw, errors });
      continue;
    }

    const existingIndex = mergedRows.findIndex(
      (candidate) => candidate.assetContractAddress === parsedRow.assetContractAddress,
    );
    if (existingIndex < 0) {
      mergedRows.push(parsedRow);
      changes[parsedRow.assetContractAddress] = "added";
      accepted.push({
        rowNumber: sourceRow.rowNumber,
        row: parsedRow,
        change: "added",
        before: null,
      });
      continue;
    }

    const before = mergedRows[existingIndex]!;
    const change: AssetCapPreviewChange = sameOverride(before, parsedRow) ? "unchanged" : "updated";
    if (change === "updated") changes[parsedRow.assetContractAddress] = "updated";
    mergedRows[existingIndex] = parsedRow;
    accepted.push({
      rowNumber: sourceRow.rowNumber,
      row: parsedRow,
      change,
      before: { ...before },
    });
  }

  return {
    ok: true,
    preview: {
      format,
      accepted,
      rejected,
      duplicateAssets,
      mergedRows,
      changes,
      totals: {
        accepted: accepted.length,
        rejected: rejected.length,
        added: accepted.filter((entry) => entry.change === "added").length,
        updated: accepted.filter((entry) => entry.change === "updated").length,
        unchanged: accepted.filter((entry) => entry.change === "unchanged").length,
        duplicates: duplicateAssets.length,
      },
    },
  };
}

export function exportAssetCapsCsv(rows: AssetCapOverride[]): string {
  return (
    [
      HEADERS.join(","),
      ...rows.map((row) =>
        [row.assetContractAddress, row.maxCapStroops, row.symbol].map(csvCell).join(","),
      ),
    ].join("\n") + "\n"
  );
}

export function exportAssetCapsJson(rows: AssetCapOverride[]): string {
  return `${JSON.stringify(
    rows.map((row) => ({
      asset_contract_address: row.assetContractAddress,
      max_cap_stroops: row.maxCapStroops,
      symbol: row.symbol,
    })),
    null,
    2,
  )}\n`;
}

export function mergeAssetCapOverrides(
  current: AssetCapOverride[],
  imported: AssetCapOverride[],
): AssetCapImport {
  const rows = [...current];
  const changes: Record<string, AssetCapChange> = {};
  for (const row of imported) {
    const existingIndex = rows.findIndex(
      (candidate) => candidate.assetContractAddress === row.assetContractAddress,
    );
    if (existingIndex < 0) {
      rows.push(row);
      changes[row.assetContractAddress] = "added";
    } else {
      if (JSON.stringify(rows[existingIndex]) !== JSON.stringify(row))
        changes[row.assetContractAddress] = "updated";
      rows[existingIndex] = row;
    }
  }
  return { rows, changes };
}

export function validateAssetCapOverrides(rows: AssetCapOverride[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    if (!row.assetContractAddress || !isAddress(row.assetContractAddress)) {
      errors.push(
        `Asset override ${index + 1}: asset_contract_address is not a valid Stellar contract address`,
      );
    }
    if (!row.maxCapStroops || !/^\d+$/.test(row.maxCapStroops)) {
      errors.push(`Asset override ${index + 1}: max_cap_stroops must be a positive integer`);
    } else if (BigInt(row.maxCapStroops) <= 0n) {
      errors.push(`Asset override ${index + 1}: max_cap_stroops must be a positive integer`);
    } else if (BigInt(row.maxCapStroops) > MAX_STROOP_CAP) {
      errors.push(`Asset override ${index + 1}: max_cap_stroops exceeds the supported i128 range`);
    }
    if (!row.symbol.trim()) errors.push(`Asset override ${index + 1}: symbol is required`);
    if (seen.has(row.assetContractAddress))
      errors.push(`Asset override ${index + 1}: duplicate asset contract address`);
    seen.add(row.assetContractAddress);
  });
  return errors;
}

function validateRows(records: string[][], source: string): AssetCapOverride[] {
  const seen = new Set<string>();
  return records.map((record, index) => {
    if (record.length !== HEADERS.length)
      throw new Error(`${source} row ${index + 2} must have three columns`);
    const [assetContractAddress, maxCapStroops, symbol] = record.map((value) => value.trim());
    if (!assetContractAddress || !isAddress(assetContractAddress)) {
      throw new Error(
        `${source} row ${index + 2}: asset_contract_address is not a valid Stellar contract address`,
      );
    }
    if (!maxCapStroops || !/^\d+$/.test(maxCapStroops) || BigInt(maxCapStroops) <= 0n) {
      throw new Error(`${source} row ${index + 2}: max_cap_stroops must be a positive integer`);
    }
    if (BigInt(maxCapStroops) > MAX_STROOP_CAP) {
      throw new Error(
        `${source} row ${index + 2}: max_cap_stroops exceeds the supported i128 range`,
      );
    }
    if (!symbol) throw new Error(`${source} row ${index + 2}: symbol is required`);
    if (seen.has(assetContractAddress))
      throw new Error(`${source} row ${index + 2}: duplicate asset contract address`);
    seen.add(assetContractAddress);
    return { assetContractAddress, maxCapStroops, symbol };
  });
}

function isAddress(value: string): boolean {
  try {
    if (!value.startsWith("C")) return false;
    Address.fromString(value);
    return true;
  } catch {
    return false;
  }
}

function sameOverride(left: AssetCapOverride, right: AssetCapOverride): boolean {
  return (
    left.assetContractAddress === right.assetContractAddress &&
    left.maxCapStroops === right.maxCapStroops &&
    left.symbol === right.symbol
  );
}

function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function boundedRaw(value: unknown, limit = 120): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const safe = text ?? String(value);
  return safe.length > limit ? `${safe.slice(0, limit)}…` : safe;
}

/**
 * Tokenise CSV while keeping each record's starting line number.
 *
 * The existing parser's cell rules are unchanged (RFC 4180 quoting, CRLF and
 * bare newlines). The extra metadata is what lets the preview point at the
 * actual line an operator must fix instead of an index that shifts after a
 * blank line.
 */
function parseCsvRecordEntries(source: string): CsvRecordEntry[] {
  const records: CsvRecordEntry[] = [];
  let record: string[] = [];
  let cell = "";
  let quoted = false;
  let line = 1;
  let recordLine = 1;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '"') {
      if (quoted && source[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      record.push(cell);
      cell = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      const wasCarriageReturn = character === "\r";
      if (wasCarriageReturn && source[index + 1] === "\n") index += 1;
      record.push(cell);
      if (record.some((value) => value !== "")) {
        records.push({ record, line: recordLine });
      }
      record = [];
      cell = "";
      line += 1;
      recordLine = line;
    } else {
      // A newline inside a quoted field is content, but it still advances the
      // source line so the next record reports the right number.
      if (character === "\n") line += 1;
      else if (character === "\r" && source[index + 1] !== "\n") line += 1;
      cell += character;
    }
  }
  if (quoted) throw new Error("CSV contains an unterminated quoted field");
  if (cell || record.length > 0) {
    record.push(cell);
    if (record.some((value) => value !== "")) {
      records.push({ record, line: recordLine });
    }
  }
  return records;
}

"use client";

import type { AssetCapImportPreview, AssetCapPreviewChange } from "../lib/guard/assetCapsCsv.ts";

const CHANGE_COPY: Record<AssetCapPreviewChange, { label: string; pill: string }> = {
  added: { label: "New asset", pill: "ok" },
  updated: { label: "Updated", pill: "warn" },
  unchanged: { label: "No change", pill: "" },
};

function capSummary(row: { maxCapStroops: string; symbol: string } | null): string {
  return row === null ? "—" : `${row.maxCapStroops} ${row.symbol}`;
}

/**
 * The review step for a bulk asset-cap import (issue #360).
 *
 * The file has already been parsed and validated; `preview` is a pure
 * description of what *would* change, including the rows that would be
 * rejected. Applying is an explicit choice made here — closing or cancelling
 * the dialog leaves the policy draft exactly as it was. The canonical contract
 * address is always shown next to the friendly symbol, and no input field is
 * written from the file until `onApply` runs.
 */
export function CsvImportPreview({
  preview,
  busy = false,
  onApply,
  onCancel,
}: {
  preview: AssetCapImportPreview;
  busy?: boolean;
  onApply: () => void;
  onCancel: () => void;
}) {
  const { totals } = preview;
  const canApply = !busy && totals.accepted > 0;

  return (
    <div className="modal-backdrop" role="presentation" onClick={onCancel}>
      <div
        className="modal csv-preview"
        role="dialog"
        aria-modal="true"
        aria-labelledby="csv-preview-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="csv-preview-title" style={{ marginTop: 0 }}>
          Review asset-cap import
        </h2>
        <p className="tiny muted">
          Nothing has been applied to the policy yet. Review every accepted row and every rejection,
          then choose whether to merge the accepted rows into the draft. The canonical asset
          contract address stays visible; the symbol is a display label, not the asset identity.
        </p>

        <div className="csv-preview-summary" aria-label="Import totals">
          <span className="pill ok">{totals.added} added</span>
          <span className="pill warn">{totals.updated} updated</span>
          <span className="pill">{totals.unchanged} unchanged</span>
          <span className={`pill${totals.rejected > 0 ? " danger" : ""}`}>
            {totals.rejected} rejected
          </span>
          {totals.duplicates > 0 && (
            <span className="pill danger">{totals.duplicates} duplicate</span>
          )}
        </div>

        <h3>Accepted rows</h3>
        {preview.accepted.length === 0 ? (
          <p className="tiny">
            No row can be applied. Fix the rejected rows in the source file and import it again.
          </p>
        ) : (
          <div className="scrolly">
            <table className="asset-caps csv-preview-table">
              <thead>
                <tr>
                  <th>Row</th>
                  <th>Asset contract</th>
                  <th>Change</th>
                  <th>Before</th>
                  <th>After</th>
                </tr>
              </thead>
              <tbody>
                {preview.accepted.map((entry) => {
                  const copy = CHANGE_COPY[entry.change];
                  return (
                    <tr key={`${entry.rowNumber}-${entry.row.assetContractAddress}`}>
                      <td className="mono tiny">{entry.rowNumber}</td>
                      <td>
                        <span className="mono tiny breakable">
                          {entry.row.assetContractAddress}
                        </span>
                      </td>
                      <td>
                        <span className={`pill ${copy.pill}`.trim()}>{copy.label}</span>
                      </td>
                      <td className="mono tiny">{capSummary(entry.before)}</td>
                      <td className="mono tiny">
                        {entry.row.maxCapStroops} {entry.row.symbol}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {preview.rejected.length > 0 && (
          <>
            <h3>Rejected rows</h3>
            <ul className="csv-preview-rejections">
              {preview.rejected.map((entry) => (
                <li key={`rejected-${entry.rowNumber}`} className="error tiny">
                  <span className="t">Row {entry.rowNumber}</span>
                  {entry.raw && <span className="mono muted breakable">{entry.raw}</span>}
                  <ul style={{ margin: "4px 0 0 16px", padding: 0 }}>
                    {entry.errors.map((error) => (
                      <li key={error}>{error}</li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </>
        )}

        {preview.duplicateAssets.length > 0 && (
          <p className="tiny muted">
            Duplicate assets are rejected rather than merged into one row:{" "}
            {preview.duplicateAssets
              .map(
                (duplicate) =>
                  `${duplicate.assetContractAddress.slice(0, 8)}… on row ${duplicate.rowNumber} (first on row ${duplicate.firstRowNumber})`,
              )
              .join(", ")}
            .
          </p>
        )}

        <div className="row" style={{ marginTop: 14 }}>
          <button
            type="button"
            onClick={onApply}
            disabled={!canApply}
            title={!canApply ? "There are no accepted rows to apply." : undefined}
          >
            {busy
              ? "Applying…"
              : `Apply ${totals.accepted} accepted row${totals.accepted === 1 ? "" : "s"}`}
          </button>
          <button type="button" className="secondary" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

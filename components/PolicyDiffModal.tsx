"use client";

import { useState } from "react";
import type { PolicyDiff, DiffEntry } from "../lib/guard/policyDiff.ts";
import { useGuard } from "./GuardProvider.tsx";
import { short } from "./bits.tsx";

/**
 * Each status three ways: a glyph, a word, and the class the stylesheet paints.
 *
 * No hex lives here on purpose. The row used to carry its own GitHub-light
 * palette, which this dark console cannot use — `#57606a` on `--panel` measures
 * 2.84:1 and the badge's `#fff8c5` panel put `--text` at 1.11:1, i.e. unreadable
 * for everyone and invisible for a screen reader either way. Colour now comes
 * from `--ok` / `--danger` / `--warn` / `--muted` through `.diff-table` in
 * `app/globals.css`, the same tiers the feed rows and the status pills use, so
 * the palette cannot drift out of contrast here without drifting everywhere —
 * and `tests/unit/policyDiffLabels.test.ts` measures the tokens it resolves to.
 *
 * The word is the part that survives assistive technology, a monochrome display
 * and a printed copy, so it is always rendered: `aria-hidden` on the glyph keeps
 * it a redundant cue rather than a duplicate announcement.
 */
const STATUS: Record<DiffEntry["status"], { glyph: string; label: string; className: string }> = {
  added: { glyph: "+", label: "added", className: "diff-added" },
  removed: { glyph: "−", label: "removed", className: "diff-removed" },
  modified: { glyph: "~", label: "changed", className: "diff-modified" },
  unchanged: { glyph: "=", label: "unchanged", className: "diff-unchanged" },
};

/** "3 changes: 1 added, 2 changed" — the shape of the diff without opening it. */
function summarize(entries: readonly DiffEntry[]): string {
  const counts = entries.reduce<Record<string, number>>((tally, entry) => {
    tally[entry.status] = (tally[entry.status] ?? 0) + 1;
    return tally;
  }, {});
  const parts = (["added", "removed", "modified"] as const)
    .filter((status) => (counts[status] ?? 0) > 0)
    .map((status) => `${counts[status]} ${STATUS[status].label}`);
  const noun = entries.length === 1 ? "change" : "changes";
  return `${entries.length} ${noun}: ${parts.join(", ")}.`;
}

function renderValue(value: unknown): string {
  if (value === undefined || value === null) return "—";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (Array.isArray(value)) {
    return value.length > 0 ? value.map(renderValue).join(", ") : "none";
  }
  return String(value);
}

/**
 * The last look an operator gets before a wallet prompt.
 *
 * `set_policy` is irreversible in the sense that matters: once signed, the new
 * caps are what the guard enforces. This renders the structured diff from
 * `lib/guard/policyDiff.ts` side by side and refuses to call `onConfirm` until
 * the operator has actually seen it.
 */
export function PolicyDiffModal({
  diff,
  expectedAccount,
  currentAccount,
  onConfirm,
  onCancel,
}: {
  diff: PolicyDiff;
  expectedAccount?: string | undefined;
  currentAccount?: string | undefined;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  let liveAddress: string | undefined = currentAccount;
  try {
    const guardContext = useGuard();
    liveAddress = currentAccount ?? guardContext.wallet?.address;
  } catch {
    // Rendered outside GuardProvider (e.g. isolated test)
  }

  // Capture the account the dialog was opened for, once, so a wallet switch
  // while it is open is reported instead of silently retargeting the change.
  const [initialAccount] = useState<string | undefined>(() => expectedAccount ?? liveAddress);
  const targetAccount = expectedAccount ?? initialAccount;
  const accountChanged = Boolean(targetAccount && liveAddress && targetAccount !== liveAddress);

  const changes = diff.entries.filter((entry) => entry.status !== "unchanged");

  return (
    <div className="modal-backdrop" role="presentation" onClick={onCancel}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Policy changes"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 style={{ marginTop: 0 }}>Policy changes</h2>
        <p className="tiny muted">
          Review what will change before the wallet is prompted to sign. Signing installs the new
          policy and resets the rolling window.
        </p>

        {accountChanged && (
          <div
            className="notice warn"
            role="alert"
            data-testid="confirmation-account-changed"
            style={{ margin: "10px 0" }}
          >
            <strong>Active account changed during review</strong>
            <p className="tiny" style={{ margin: "4px 0" }}>
              The connected account changed from{" "}
              <span className="mono">{short(targetAccount!, 8, 6)}</span> to{" "}
              <span className="mono">{short(liveAddress!, 8, 6)}</span> while this confirmation was
              open. This policy change was prepared and simulated for the previous account.
            </p>
            <p className="tiny muted" style={{ margin: "4px 0" }}>
              <strong>Recovery:</strong> Cancel this confirmation to re-run policy review with the
              active account, or switch your wallet back to{" "}
              <span className="mono">{short(targetAccount!, 8, 6)}</span>.
            </p>
          </div>
        )}

        {diff.warnings.length > 0 && (
          <div className="notice diff-warnings" role="alert">
            <strong>Warning</strong>
            {diff.warnings.map((warning, index) => (
              <div key={index}>
                <span aria-hidden="true">⚠ </span>
                {warning}
              </div>
            ))}
          </div>
        )}

        {changes.length === 0 ? (
          <p className="tiny">This policy is identical to the one currently installed.</p>
        ) : (
          <>
            <p className="tiny muted diff-summary">{summarize(changes)}</p>
            <table className="diff-table">
              <caption className="visually-hidden">
                Fields this policy changes, with the value on chain now and the value a signature
                would install.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Field</th>
                  <th scope="col">Current</th>
                  <th scope="col">New</th>
                </tr>
              </thead>
              <tbody>
                {changes.map((entry) => {
                  const status = STATUS[entry.status];
                  return (
                    <tr key={entry.field} className={status.className} data-status={entry.status}>
                      <th scope="row">
                        <span className="diff-glyph" aria-hidden="true">
                          {status.glyph}
                        </span>
                        <span className="diff-field">{entry.field}</span>
                        <span className="diff-status">{` (${status.label})`}</span>
                      </th>
                      <td className="mono tiny">{renderValue(entry.oldValue)}</td>
                      <td className="mono tiny">{renderValue(entry.newValue)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        )}

        <div className="row" style={{ marginTop: 14 }}>
          <button
            disabled={changes.length === 0 || accountChanged}
            onClick={() => {
              if (accountChanged) return;
              onConfirm();
            }}
          >
            Confirm and sign
          </button>
          <button className="secondary" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

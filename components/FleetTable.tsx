"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { formatStroopsWithUnit } from "../lib/guard/formatters.ts";
import { POLLING, jitteredInterval } from "../lib/guard/polling.ts";
import {
  pollFleet,
  defaultSortDirection,
  type FleetRow,
  type DerivedStatus,
  type SortKey,
} from "../lib/guard/fleet.ts";
import { loadInstances } from "../lib/guard/instance.ts";
import { freezeGuard } from "../lib/guard/guardOps.ts";
import { freezeFailed, freezeSubmitted, writeFailureReason } from "../lib/guard/announceCopy.ts";
import { announce } from "../lib/guard/useAnnounce.ts";
import { NETWORK } from "../lib/guard/network.ts";
import { useGuard } from "./GuardProvider.tsx";
import {
  DEFAULT_FLEET_VIEW,
  applyFleetView,
  createFleetViewStore,
  fleetTableState,
  fleetEmptyCopy,
  hasActiveFleetFilter,
  isDefaultFleetView,
  type FleetViewState,
} from "../lib/guard/fleetTableState.ts";
import { Skeleton, starLink } from "./bits.tsx";
import { useRouter } from "next/navigation";
import { freighterSigner } from "../lib/guard/wallet.ts";
import {
  captureRegistryBackup,
  planBulkCleanup,
  type BulkCleanupPlan,
  type CleanupEntry,
  type RegistryBackup,
} from "../lib/guard/registry.ts";

// One store for the tab: the remembered view (search, filters, sort), never row data.
const fleetViewStore = createFleetViewStore({ networks: [NETWORK.name] });

/**
 * What the confirmation says about the boundary of a cleanup: this browser's
 * list is cleared, the contracts on chain are not, and the change can be put
 * back in one step. Kept here rather than inline so the paragraph is one string
 * the formatter treats as a unit.
 */
const CLEANUP_COPY =
  "Every address and label below will be cleared from this browser's registry. No contract on chain is deleted or changed, and the previous list can be restored in one step.";

/** The same explanation, counted: how many selected entries were left alone. */
function skippedCopy(count: number): string {
  const noun = count === 1 ? "entry was" : "entries were";
  return `${count} selected ${noun} kept: a build-seeded guard is a constant of this build and cannot be deleted.`;
}

export function FleetTable() {
  const { wallet, server, instances, guard, removeInstances, restoreRegistry } = useGuard();
  const router = useRouter();

  const [rows, setRows] = useState<FleetRow[]>([]);
  const [loading, setLoading] = useState(true);
  // Bumped after a registry write so the table re-reads immediately instead of
  // waiting out the poll interval with rows it already knows are stale.
  const [refreshKey, setRefreshKey] = useState(0);
  // The operator's selection, as addresses. Kept as a list rather than a Set so
  // the order a row was ticked in survives, which is what the confirm shows.
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [cleanupPlan, setCleanupPlan] = useState<Extract<BulkCleanupPlan, { ok: true }> | null>(
    null,
  );
  const [cleanupError, setCleanupError] = useState<string | null>(null);
  const [undo, setUndo] = useState<{ backup: RegistryBackup; count: number } | null>(null);

  // The operator's view of the table (search, filters, sort). It is remembered
  // across visits but is not registry data: only these choices are stored, never
  // a row or a status read from the chain. The store serves the default view to
  // the server and to hydration, then the remembered one.
  const view = useSyncExternalStore(
    fleetViewStore.subscribe,
    fleetViewStore.getSnapshot,
    fleetViewStore.getServerSnapshot,
  );
  const { search, network: networkFilter, status: statusFilter, sortKey, sortDirection } = view;
  const updateView = (patch: Partial<FleetViewState>) => fleetViewStore.set({ ...view, ...patch });

  useEffect(() => {
    let mounted = true;
    const fetchFleet = async () => {
      const instances = loadInstances();
      const contacts = instances.map((i) => ({
        address: i.guard,
        label: i.label,
        addedAt: "",
      }));
      const result = await pollFleet(server, contacts);
      if (mounted) {
        setRows(result);
        setLoading(false);
      }
    };

    fetchFleet();
    const interval = setInterval(fetchFleet, jitteredInterval(POLLING.fleetMs));
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [server, refreshKey]);

  // Derived from the rows as last read, so a poll that changes a guard's status
  // immediately moves it in or out of the filtered, sorted view.
  const filteredAndSorted = useMemo(() => applyFleetView(rows, view), [rows, view]);

  const tableState = fleetTableState({
    loading,
    registryCount: rows.length,
    filteredCount: filteredAndSorted.length,
  });
  const empty = fleetEmptyCopy(tableState);

  const clearFilters = () => updateView({ search: "", network: null, status: null });
  // Back to registry order with nothing filtered.
  const resetView = () => fleetViewStore.set(DEFAULT_FLEET_VIEW);
  const viewIsDefault = isDefaultFleetView(view);
  const filtering = hasActiveFleetFilter(view);

  const visibleAddresses = filteredAndSorted.map((row) => row.contact.address);
  const allVisibleSelected =
    visibleAddresses.length > 0 && visibleAddresses.every((address) => selected.includes(address));

  const toggleSelected = (address: string) => {
    setCleanupError(null);
    setSelected((current) =>
      current.includes(address)
        ? current.filter((entry) => entry !== address)
        : [...current, address],
    );
  };

  const toggleAllVisible = () => {
    setCleanupError(null);
    setSelected((current) =>
      allVisibleSelected
        ? current.filter((address) => !visibleAddresses.includes(address))
        : [...new Set([...current, ...visibleAddresses])],
    );
  };

  /**
   * Ask for confirmation before anything is written.
   *
   * The plan is the whole point: an empty selection, a duplicated address and a
   * build-seeded guard each resolve here rather than at the storage layer, so the
   * dialog that follows can only ever offer entries that would really be removed.
   */
  const openCleanup = () => {
    const plan = planBulkCleanup({ instances, selected });
    if (!plan.ok) {
      setCleanupPlan(null);
      setCleanupError(plan.error);
      return;
    }
    setCleanupError(null);
    setCleanupPlan(plan);
  };

  const confirmCleanup = () => {
    if (!cleanupPlan) return;
    // Captured first: the backup has to describe the registry as it is *now*,
    // not as the write will leave it.
    const backup = captureRegistryBackup({ activeGuard: guard });
    const count = cleanupPlan.entries.length;
    const removed = removeInstances(cleanupPlan.entries.map((entry) => entry.guard));
    setCleanupPlan(null);
    setSelected([]);
    if (removed) setUndo({ backup, count });
    setRefreshKey((key) => key + 1);
  };

  const undoCleanup = () => {
    if (!undo) return;
    restoreRegistry(undo.backup);
    setUndo(null);
    setRefreshKey((key) => key + 1);
  };

  const handleFreeze = async (guard: string) => {
    if (!wallet) {
      alert("Please connect your wallet first to freeze a guard.");
      return;
    }
    try {
      const result = await freezeGuard({
        server,
        signer: freighterSigner(wallet.address, NETWORK.passphrase),
        guard,
      });
      // The fleet table has no snapshot to re-read, so it announces what it does
      // have: the submission receipt, and the reason when there wasn't one. This
      // is the only freeze path left without a chain re-read behind its claim —
      // the panic panel announces its verified outcome instead (issue #30), so a
      // freeze is spoken exactly once no matter which page ran it.
      const spoken =
        result.kind === "submitted"
          ? freezeSubmitted(guard)
          : freezeFailed("freeze", writeFailureReason(result, "the write did not complete"), guard);
      announce(spoken.message, spoken.priority);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const spoken = freezeFailed("freeze", detail, guard);
      announce(spoken.message, spoken.priority);
      console.error(err);
    }
  };

  const renderStatus = (status: DerivedStatus) => {
    switch (status) {
      case "Active":
        return <span className="pill ok">Active</span>;
      case "Frozen":
        return <span className="pill danger">Frozen</span>;
      case "Expired":
        return <span className="pill warn">Expired</span>;
      case "Unknown":
        return <span className="pill muted">Unknown</span>;
      default:
        return <span className="pill muted">Unknown</span>;
    }
  };

  const renderError = (error?: string | null) => {
    if (!error) return null;
    return <span className="pill danger tiny">Read error: {error}</span>;
  };

  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>Fleet Overview</h2>
        <span className="tiny muted">
          {rows.length} guard{rows.length !== 1 ? "s" : ""} in registry
        </span>
      </div>

      <div className="split" style={{ marginTop: 12 }}>
        <label className="field" style={{ marginBottom: 0, flex: 2 }}>
          <span className="lbl">Search</span>
          <input
            type="search"
            value={search}
            onChange={(e) => updateView({ search: e.target.value })}
            placeholder="Search by name or address..."
          />
        </label>

        <div className="row" style={{ flex: 3 }}>
          <label className="field" style={{ marginBottom: 0, flex: 1 }}>
            <span className="lbl">Network</span>
            <select
              value={networkFilter || ""}
              onChange={(e) => updateView({ network: e.target.value || null })}
            >
              <option value="">All Networks</option>
              <option value={NETWORK.name}>{NETWORK.name}</option>
            </select>
          </label>
          <label className="field" style={{ marginBottom: 0, flex: 1 }}>
            <span className="lbl">Status</span>
            <select
              value={statusFilter || ""}
              onChange={(e) => updateView({ status: (e.target.value as DerivedStatus) || null })}
            >
              <option value="">All Statuses</option>
              <option value="Active">Active</option>
              <option value="Frozen">Frozen</option>
              <option value="Expired">Expired</option>
              {/* Unread is its own state, not a flavour of healthy: a guard whose
                  read failed matches this and never "Active". */}
              <option value="Unknown">Unknown (not read)</option>
            </select>
          </label>
          <label className="field" style={{ marginBottom: 0, flex: 1 }}>
            <span className="lbl">Sort</span>
            <select
              value={sortKey || ""}
              onChange={(e) => {
                const key = (e.target.value as SortKey) || null;
                updateView({
                  sortKey: key,
                  sortDirection: key ? defaultSortDirection(key) : "asc",
                });
              }}
            >
              <option value="">Registry order</option>
              <option value="label">Label</option>
              <option value="address">Address</option>
              <option value="status">Status (needs attention first)</option>
              <option value="spend">Spend (High to Low)</option>
              <option value="expiration">Expiration (Soonest)</option>
            </select>
          </label>
        </div>
      </div>

      <div className="row" style={{ marginTop: 8, gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {sortKey && (
          <button
            type="button"
            className="secondary"
            style={{ padding: "4px 8px", fontSize: "0.8em" }}
            onClick={() => updateView({ sortDirection: sortDirection === "asc" ? "desc" : "asc" })}
            aria-label={`Sort direction: ${sortDirection === "asc" ? "ascending" : "descending"}. Activate to reverse.`}
          >
            {sortDirection === "asc" ? "Ascending ↑" : "Descending ↓"}
          </button>
        )}
        {!viewIsDefault && (
          <button
            type="button"
            className="secondary"
            style={{ padding: "4px 8px", fontSize: "0.8em" }}
            onClick={resetView}
          >
            Reset view
          </button>
        )}
        {filtering && tableState.kind === "rows" && (
          <span className="tiny muted" role="status">
            Showing {filteredAndSorted.length} of {rows.length} guard{rows.length !== 1 ? "s" : ""}
          </span>
        )}
        {tableState.kind === "rows" && (
          <span className="tiny muted" role="status">
            {selected.length} of {filteredAndSorted.length} selected
          </span>
        )}
        {selected.length > 0 && (
          <button
            type="button"
            className="danger"
            style={{ padding: "4px 8px", fontSize: "0.8em" }}
            onClick={openCleanup}
          >
            Remove selected ({selected.length})
          </button>
        )}
      </div>

      {cleanupError && (
        <div className="notice warn" role="alert" style={{ marginTop: 8 }}>
          <strong>Nothing was removed</strong>
          <span className="tiny">{cleanupError}</span>
        </div>
      )}

      {undo && (
        <div className="notice info" role="status" data-testid="registry-cleanup-undo">
          <strong>
            Removed {undo.count} saved guard{undo.count !== 1 ? "s" : ""} from this browser
          </strong>
          <span className="tiny">
            Nothing on chain was touched — this only cleared this browser&apos;s list.
          </span>
          <div className="row" style={{ marginTop: 6 }}>
            <button
              type="button"
              className="secondary"
              style={{ padding: "4px 8px", fontSize: "0.8em" }}
              onClick={undoCleanup}
            >
              Restore previous registry
            </button>
            <button
              type="button"
              className="secondary"
              style={{ padding: "4px 8px", fontSize: "0.8em" }}
              onClick={() => setUndo(null)}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      <div className="scrolly table-stack" style={{ marginTop: 14 }}>
        <table className="events stack">
          <thead>
            <tr>
              <th scope="col">
                <input
                  type="checkbox"
                  checked={allVisibleSelected}
                  onChange={toggleAllVisible}
                  aria-label="Select all guards shown"
                />
              </th>
              <th scope="col">Guard</th>
              <th scope="col">Network</th>
              <th scope="col">Status</th>
              <th scope="col">24h Spend</th>
              <th scope="col">DMS Countdown</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {tableState.kind === "loading" &&
              /* The initial fleet poll is a pending read, so it reserves the
                 table's shape with skeleton rows instead of a text line that
                 collapses when the rows land. Not zeros, not an empty state. */
              [0, 1, 2].map((row) => (
                <tr key={row} aria-busy="true" aria-hidden="true">
                  <td>
                    <Skeleton lines={1} />
                  </td>
                  <td>
                    <Skeleton lines={1} />
                  </td>
                  <td>
                    <Skeleton lines={1} />
                  </td>
                  <td>
                    <Skeleton lines={1} />
                  </td>
                  <td>
                    <Skeleton lines={1} />
                  </td>
                  <td>
                    <Skeleton lines={1} />
                  </td>
                  <td>
                    <Skeleton lines={1} />
                  </td>
                </tr>
              ))}
            {tableState.kind === "registry-empty" && (
              <tr>
                <td
                  colSpan={7}
                  className="fleet-empty"
                  style={{ textAlign: "center", padding: "28px 20px" }}
                >
                  <strong>{empty!.title}</strong>
                  <span className="tiny muted">{empty!.hint}</span>
                  <div style={{ marginTop: 10 }}>
                    <Link href="/configure">Open the Configure page</Link>
                  </div>
                </td>
              </tr>
            )}
            {tableState.kind === "filter-empty" && (
              <tr>
                <td
                  colSpan={7}
                  className="fleet-empty"
                  style={{ textAlign: "center", padding: "28px 20px" }}
                >
                  <strong>{empty!.title}</strong>
                  <span className="tiny muted">{empty!.hint}</span>
                  <div style={{ marginTop: 10 }}>
                    <button className="secondary" onClick={clearFilters}>
                      Clear search and filters
                    </button>
                  </div>
                </td>
              </tr>
            )}
            {tableState.kind === "rows" &&
              filteredAndSorted.map((row) => (
                <tr key={row.contact.address}>
                  <td data-label="Select">
                    <input
                      type="checkbox"
                      checked={selected.includes(row.contact.address)}
                      onChange={() => toggleSelected(row.contact.address)}
                      aria-label={`Select ${row.contact.label}`}
                    />
                  </td>
                  <td data-label="Guard">
                    <div>
                      <strong>{row.contact.label}</strong>
                    </div>
                    <div className="mono tiny">{starLink(row.contact.address)}</div>
                  </td>
                  <td className="tiny" data-label="Network">
                    {row.network}
                  </td>
                  <td data-label="Status">{renderStatus(row.derivedStatus)}</td>
                  <td className="mono tiny" data-label="24h Spend">
                    {formatStroopsWithUnit(row.spend24h)}
                  </td>
                  <td className="mono tiny" data-label="DMS Countdown">
                    {row.dmsCountdownSecs !== null ? `${row.dmsCountdownSecs}s` : "—"}
                  </td>
                  <td data-label="Actions">
                    <div className="row" style={{ gap: "8px", flexWrap: "wrap" }}>
                      <button
                        className="secondary"
                        style={{ padding: "4px 8px", fontSize: "0.8em" }}
                        onClick={() => router.push(`/?guard=${row.contact.address}`)}
                      >
                        Inspect
                      </button>
                      {row.retry && (
                        <button
                          className="secondary"
                          style={{ padding: "4px 8px", fontSize: "0.8em" }}
                          onClick={() => row.retry!()}
                          disabled={row.derivedStatus !== "Unknown"}
                        >
                          Retry
                        </button>
                      )}
                      {row.error && (
                        <span className="tiny muted" title={row.error}>
                          ⚠
                        </span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      {cleanupPlan && (
        <BulkCleanupModal
          plan={cleanupPlan}
          onClose={() => setCleanupPlan(null)}
          onConfirm={confirmCleanup}
        />
      )}
    </div>
  );
}

/**
 * Confirm a bulk removal, showing exactly what it will remove (issue #302).
 *
 * A deletion is never a single click in this console (issue #22), and a bulk one
 * has to be reviewed address by address before it is applied: the list here is
 * the plan itself, so what the operator reads is what is written. The copy also
 * states the boundary that matters — the browser's saved list is cleared, the
 * contracts on chain are not touched — and the caller keeps a one-step restore
 * of the registry as it was.
 */
export function BulkCleanupModal({
  plan,
  onClose,
  onConfirm,
}: {
  plan: Extract<BulkCleanupPlan, { ok: true }>;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  const count = plan.entries.length;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="bulk-cleanup-title"
        ref={dialogRef}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <strong id="bulk-cleanup-title">
          Remove {count} saved guard{count !== 1 ? "s" : ""} from this browser?
        </strong>
        <p className="tiny muted">{CLEANUP_COPY}</p>
        <div className="scrolly" style={{ maxHeight: 220, marginTop: 8 }}>
          <table className="events">
            <thead>
              <tr>
                <th scope="col">Label</th>
                <th scope="col">Address</th>
                <th scope="col">Network</th>
              </tr>
            </thead>
            <tbody>
              {plan.entries.map((entry: CleanupEntry) => (
                <tr key={entry.guard}>
                  <td data-label="Label">{entry.label}</td>
                  <td className="mono tiny" data-label="Address">
                    {entry.guard}
                  </td>
                  <td className="tiny" data-label="Network">
                    {entry.network}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {plan.skipped.length > 0 && (
          <p className="tiny muted">{skippedCopy(plan.skipped.length)}</p>
        )}
        <div className="row" style={{ marginTop: 12 }}>
          <button className="danger" onClick={onConfirm}>
            Remove {count} guard{count !== 1 ? "s" : ""}
          </button>
          <button className="secondary" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

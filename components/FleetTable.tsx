"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { formatStroopsWithUnit } from "../lib/guard/formatters.ts";
import { POLLING, jitteredInterval } from "../lib/guard/polling.ts";
import { refreshSources, type RefreshSource } from "../lib/guard/refreshStatus.ts";
import {
  pollFleet,
  defaultSortDirection,
  computeFleetRiskSummary,
  getAllFleetTags,
  addGuardTag,
  removeGuardTag,
  setPreferredDisplayName,
  generateFleetPolicyReport,
  formatFleetPolicyReportMarkdown,
  type FleetRow,
  type DerivedStatus,
  type SortKey,
  type FleetRiskSummary,
  type FleetPolicyReport,
} from "../lib/guard/fleet.ts";
import {
  defaultGuardLabel,
  loadInstances,
  rememberInstance,
  type GuardInstance,
} from "../lib/guard/instance.ts";
import { freezeGuard } from "../lib/guard/guardOps.ts";
import { freezeFailed, freezeSubmitted, writeFailureReason } from "../lib/guard/announceCopy.ts";
import { announce } from "../lib/guard/useAnnounce.ts";
import { NETWORK } from "../lib/guard/network.ts";
import { useGuard } from "./GuardProvider.tsx";
import {
  DEFAULT_FLEET_VIEW,
  DEFAULT_FLEET_COLUMNS,
  loadFleetColumns,
  saveFleetColumns,
  resetFleetColumns,
  applyFleetView,
  createFleetViewStore,
  fleetTableState,
  fleetEmptyCopy,
  hasActiveFleetFilter,
  isDefaultFleetView,
  type FleetViewState,
  type FleetColumnConfig,
  type FleetColumnId,
} from "../lib/guard/fleetTableState.ts";
import { Skeleton, starLink } from "./bits.tsx";
import { useRouter } from "next/navigation";
import { freighterSigner } from "../lib/guard/wallet.ts";
import {
  captureRegistryBackup,
  isValidGuardAddress,
  planBulkCleanup,
  previewRegistryMerge,
  type BulkCleanupPlan,
  type CleanupEntry,
  type RegistryBackup,
  type RegistryMergePreview,
} from "../lib/guard/registry.ts";

// One store for the tab: the remembered view (search, filters, sort), never row data.
const fleetViewStore = createFleetViewStore({ networks: [NETWORK.name] });

/** Drawn once per page load, then shared by the timer and the strip's overdue window. */
const FLEET_INTERVAL_MS = jitteredInterval(POLLING.fleetMs);

/**
 * The fleet poller's own liveness, beside the rows it produced (#528).
 *
 * `pollFleet` never rejects: a guard it cannot read comes back as a row with an
 * `error` and no snapshot. So "the round failed" is a count, not an exception -
 * and it is only a failure when there was something to read. An empty registry is
 * a round that answered perfectly and had nothing to say.
 */
const INITIAL_FLEET_READ: FleetRead = {
  polling: false,
  lastSuccessAt: null,
  lastFailureAt: null,
  error: null,
  rowsRead: 0,
};

interface FleetRead {
  polling: boolean;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  error: string | null;
  rowsRead: number;
}

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

  // Operator-selected fleet column layout preferences (issue #476)
  const [columns, setColumns] = useState<FleetColumnConfig[]>(() => loadFleetColumns());
  const [showColumnModal, setShowColumnModal] = useState(false);
  const [showPolicyReport, setShowPolicyReport] = useState(false);
  const [showRegisterModal, setShowRegisterModal] = useState(false);
  const [showMergeModal, setShowMergeModal] = useState(false);

  const visibleColumns = useMemo(() => columns.filter((c) => c.visible), [columns]);

  const handleUpdateColumns = (next: FleetColumnConfig[]) => {
    setColumns(next);
    saveFleetColumns(next);
  };

  const handleResetColumns = () => {
    const next = resetFleetColumns();
    setColumns(next);
  };

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

  const [fleetRead, setFleetRead] = useState<FleetRead>(INITIAL_FLEET_READ);

  useEffect(() => {
    let mounted = true;
    const fetchFleet = async () => {
      const instances = loadInstances();
      const contacts = instances.map((i) => ({
        address: i.guard,
        label: i.label,
        addedAt: "",
      }));
      setFleetRead((current) => ({ ...current, polling: true }));
      try {
        const result = await pollFleet(server, contacts);
        if (!mounted) return;
        setRows(result);
        setLoading(false);
        const answered = result.filter((row) => row.snapshot !== null).length;
        const failed = result.find((row) => row.error !== undefined);
        const completedAt = new Date().toISOString();
        setFleetRead((current) =>
          contacts.length === 0 || answered > 0
            ? {
                polling: false,
                // The success stamp moves on a round that returned nothing: an
                // empty registry is a live poller with no guards, which is not the
                // same fault as a poller that cannot reach the network.
                lastSuccessAt: completedAt,
                lastFailureAt: current.lastFailureAt,
                // One guard unreadable among several is that row's failure, shown
                // on the row; the round itself answered.
                error: answered === 0 && failed ? (failed.error ?? null) : null,
                rowsRead: answered,
              }
            : {
                polling: false,
                lastSuccessAt: current.lastSuccessAt,
                lastFailureAt: completedAt,
                error: failed ? (failed.error ?? null) : "every guard read failed",
                rowsRead: 0,
              },
        );
      } catch (error) {
        if (!mounted) return;
        const failedAt = new Date().toISOString();
        setFleetRead((current) => ({
          polling: false,
          lastSuccessAt: current.lastSuccessAt,
          lastFailureAt: failedAt,
          error: error instanceof Error ? error.message : String(error),
          rowsRead: 0,
        }));
      }
    };

    fetchFleet();
    const interval = setInterval(fetchFleet, FLEET_INTERVAL_MS);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [server, refreshKey]);

  const fleetSource = useMemo<RefreshSource>(
    () => ({
      id: "fleet",
      intervalMs: FLEET_INTERVAL_MS,
      // The timer runs for as long as this table is mounted, registry or not.
      watching: true,
      polling: fleetRead.polling,
      lastSuccessAt: fleetRead.lastSuccessAt,
      lastAttemptAt: null,
      lastFailureAt: fleetRead.lastFailureAt,
      error: fleetRead.error,
      deliveredInLastRound: fleetRead.rowsRead,
      paused: false,
    }),
    [fleetRead],
  );

  useEffect(() => {
    refreshSources.publish(fleetSource);
  }, [fleetSource]);

  // The fleet poller only exists on this screen; the strip must not keep showing a
  // cadence for a timer that stopped when the operator navigated away.
  useEffect(
    () => () => {
      refreshSources.retire("fleet");
    },
    [],
  );

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
        <button
          type="button"
          className="secondary"
          style={{ padding: "4px 8px", fontSize: "0.8em" }}
          onClick={() => setShowColumnModal(true)}
        >
          Columns
        </button>
        <button
          type="button"
          className="secondary"
          style={{ padding: "4px 8px", fontSize: "0.8em" }}
          onClick={() => setShowPolicyReport(true)}
        >
          Policy Report
        </button>
        <button
          type="button"
          className="secondary"
          style={{ padding: "4px 8px", fontSize: "0.8em" }}
          onClick={() => setShowRegisterModal(true)}
        >
          Register Guard
        </button>
        <button
          type="button"
          className="secondary"
          style={{ padding: "4px 8px", fontSize: "0.8em" }}
          onClick={() => setShowMergeModal(true)}
        >
          Import Registry
        </button>
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
              {visibleColumns.map((col) => {
                switch (col.id) {
                  case "selection":
                    return (
                      <th key="selection" scope="col">
                        <input
                          type="checkbox"
                          checked={allVisibleSelected}
                          onChange={toggleAllVisible}
                          aria-label="Select all guards shown"
                        />
                      </th>
                    );
                  case "guard":
                    return (
                      <th key="guard" scope="col">
                        Guard
                      </th>
                    );
                  case "network":
                    return (
                      <th key="network" scope="col">
                        Network
                      </th>
                    );
                  case "status":
                    return (
                      <th key="status" scope="col">
                        Status
                      </th>
                    );
                  case "policyAge":
                    return (
                      <th key="policyAge" scope="col">
                        Policy Age
                      </th>
                    );
                  case "tags":
                    return (
                      <th key="tags" scope="col">
                        Tags
                      </th>
                    );
                  case "spend":
                    return (
                      <th key="spend" scope="col">
                        24h Spend
                      </th>
                    );
                  case "dms":
                    return (
                      <th key="dms" scope="col">
                        DMS Countdown
                      </th>
                    );
                  case "actions":
                    return (
                      <th key="actions" scope="col">
                        Actions
                      </th>
                    );
                  default:
                    return null;
                }
              })}
            </tr>
          </thead>
          <tbody>
            {tableState.kind === "loading" &&
              /* The initial fleet poll is a pending read, so it reserves the
                 table's shape with skeleton rows instead of a text line that
                 collapses when the rows land. Not zeros, not an empty state. */
              [0, 1, 2].map((row) => (
                <tr key={row} aria-busy="true" aria-hidden="true">
                  {visibleColumns.map((col) => (
                    <td key={col.id}>
                      <Skeleton lines={1} />
                    </td>
                  ))}
                </tr>
              ))}
            {tableState.kind === "registry-empty" && (
              <tr>
                <td
                  colSpan={visibleColumns.length}
                  className="fleet-empty"
                  style={{ textAlign: "center", padding: "28px 20px" }}
                >
                  <strong>{empty!.title}</strong>
                  <span className="tiny muted">{empty!.hint}</span>
                  <p className="tiny muted" style={{ maxWidth: 520, margin: "8px auto 0 auto" }}>
                    Fleet membership is browser-local: guards only appear here if registered in this
                    browser&apos;s registry. If you deployed a guard via CLI or another machine,
                    register its address below to monitor it. Registration saves this address
                    locally; it does NOT deploy, verify, or create a contract on-chain.
                  </p>
                  <div className="row" style={{ marginTop: 12, justifyContent: "center", gap: 12 }}>
                    <button className="secondary" onClick={() => setShowRegisterModal(true)}>
                      Register Guard
                    </button>
                    <Link href="/configure">Open the Configure page</Link>
                  </div>
                </td>
              </tr>
            )}
            {tableState.kind === "filter-empty" && (
              <tr>
                <td
                  colSpan={visibleColumns.length}
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
                  <div
                    className="notice info"
                    style={{ maxWidth: 520, margin: "16px auto 0 auto", textAlign: "left" }}
                  >
                    <strong>Cannot find a deployed guard?</strong>
                    <p className="tiny muted" style={{ margin: "4px 0" }}>
                      Fleet membership is browser-local: guards only appear here if registered in
                      this browser&apos;s registry. If you deployed a guard via CLI or another
                      machine, register its address below to monitor it. Registration saves this
                      address locally; it does NOT deploy, verify, or create a contract on-chain.
                    </p>
                    <button
                      className="secondary"
                      style={{ padding: "4px 8px", fontSize: "0.8em", marginTop: 4 }}
                      onClick={() => setShowRegisterModal(true)}
                    >
                      Register Guard
                    </button>
                  </div>
                </td>
              </tr>
            )}
            {tableState.kind === "rows" &&
              filteredAndSorted.map((row) => (
                <tr key={row.contact.address}>
                  {visibleColumns.map((col) => {
                    switch (col.id) {
                      case "selection":
                        return (
                          <td key="selection" data-label="Select">
                            <input
                              type="checkbox"
                              checked={selected.includes(row.contact.address)}
                              onChange={() => toggleSelected(row.contact.address)}
                              aria-label={`Select ${row.displayName || row.contact.label}`}
                            />
                          </td>
                        );
                      case "guard":
                        return (
                          <td key="guard" data-label="Guard">
                            <div className="row" style={{ alignItems: "center", gap: 6 }}>
                              <strong data-testid={`display-name-${row.contact.address}`}>
                                {row.displayName || row.contact.label}
                              </strong>
                              <button
                                type="button"
                                className="secondary"
                                data-testid={`edit-display-name-${row.contact.address}`}
                                style={{ padding: "1px 5px", fontSize: "0.7em" }}
                                title="Edit local display name"
                                onClick={() => {
                                  const currentName = row.displayName || row.contact.label;
                                  const nextName = prompt(
                                    "Enter preferred display name (browser-local):",
                                    currentName,
                                  );
                                  if (nextName !== null) {
                                    setPreferredDisplayName(
                                      NETWORK.name,
                                      row.contact.address,
                                      nextName,
                                    );
                                    setRefreshKey((k) => k + 1);
                                  }
                                }}
                              >
                                edit
                              </button>
                            </div>
                            <div
                              className="mono tiny"
                              data-testid={`full-address-${row.contact.address}`}
                            >
                              {starLink(row.contact.address)}
                            </div>
                          </td>
                        );
                      case "network":
                        return (
                          <td key="network" className="tiny" data-label="Network">
                            {row.network}
                          </td>
                        );
                      case "status":
                        return (
                          <td key="status" data-label="Status">
                            {renderStatus(row.derivedStatus)}
                          </td>
                        );
                      case "policyAge":
                        return (
                          <td
                            key="policyAge"
                            className="tiny"
                            data-label="Policy Age"
                            data-testid={`policy-age-${row.contact.address}`}
                          >
                            {row.policyAge?.display ?? "unavailable"}
                          </td>
                        );
                      case "tags":
                        return (
                          <td key="tags" data-label="Tags">
                            <div
                              className="row"
                              style={{ gap: 4, flexWrap: "wrap", alignItems: "center" }}
                            >
                              {row.tags && row.tags.length > 0 ? (
                                row.tags.map((tag) => (
                                  <span
                                    key={tag}
                                    className="pill tiny"
                                    data-testid={`tag-pill-${tag}`}
                                    style={{ display: "inline-flex", alignItems: "center", gap: 3 }}
                                  >
                                    {tag}
                                    <button
                                      type="button"
                                      aria-label={`Remove tag ${tag}`}
                                      data-testid={`remove-tag-${tag}`}
                                      style={{
                                        background: "none",
                                        border: "none",
                                        cursor: "pointer",
                                        padding: 0,
                                        fontSize: "10px",
                                        lineHeight: 1,
                                      }}
                                      onClick={() => {
                                        removeGuardTag(NETWORK.name, row.contact.address, tag);
                                        setRefreshKey((k) => k + 1);
                                      }}
                                    >
                                      ×
                                    </button>
                                  </span>
                                ))
                              ) : (
                                <span className="tiny muted">—</span>
                              )}
                              <button
                                type="button"
                                className="secondary"
                                data-testid={`add-tag-btn-${row.contact.address}`}
                                style={{ padding: "1px 5px", fontSize: "0.7em" }}
                                title="Add browser-local tag"
                                onClick={() => {
                                  const tag = prompt("Enter tag name (browser-local):");
                                  if (tag && tag.trim()) {
                                    addGuardTag(NETWORK.name, row.contact.address, tag.trim());
                                    setRefreshKey((k) => k + 1);
                                  }
                                }}
                              >
                                + tag
                              </button>
                            </div>
                          </td>
                        );
                      case "spend":
                        return (
                          <td key="spend" className="mono tiny" data-label="24h Spend">
                            {formatStroopsWithUnit(row.spend24h)}
                          </td>
                        );
                      case "dms":
                        return (
                          <td key="dms" className="mono tiny" data-label="DMS Countdown">
                            {row.dmsCountdownSecs !== null ? `${row.dmsCountdownSecs}s` : "—"}
                          </td>
                        );
                      case "actions":
                        return (
                          <td key="actions" data-label="Actions">
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
                        );
                      default:
                        return null;
                    }
                  })}
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

      {showColumnModal && (
        <ColumnLayoutModal
          columns={columns}
          onClose={() => setShowColumnModal(false)}
          onChange={handleUpdateColumns}
          onReset={handleResetColumns}
        />
      )}

      {showPolicyReport && (
        <PolicyReportModal rows={rows} onClose={() => setShowPolicyReport(false)} />
      )}

      {showRegisterModal && (
        <RegisterGuardModal
          onClose={() => setShowRegisterModal(false)}
          onRegistered={() => setRefreshKey((k) => k + 1)}
        />
      )}

      {showMergeModal && (
        <RegistryMergeModal
          instances={instances}
          onClose={() => setShowMergeModal(false)}
          onMerged={() => setRefreshKey((k) => k + 1)}
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

/**
 * Configure visible columns and adjust their presentation order (issue #476).
 */
export function ColumnLayoutModal({
  columns,
  onClose,
  onChange,
  onReset,
}: {
  columns: FleetColumnConfig[];
  onClose: () => void;
  onChange: (next: FleetColumnConfig[]) => void;
  onReset: () => void;
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

  const toggleColumn = (id: FleetColumnId) => {
    const next = columns.map((col) =>
      col.id === id && col.canHide ? { ...col, visible: !col.visible } : col,
    );
    onChange(next);
  };

  const moveColumn = (index: number, direction: "up" | "down") => {
    const targetIndex = direction === "up" ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= columns.length) return;
    const next = [...columns];
    const item = next[index]!;
    next[index] = next[targetIndex]!;
    next[targetIndex] = item;
    onChange(next);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="column-layout-title"
        ref={dialogRef}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        style={{ maxWidth: 500 }}
      >
        <strong id="column-layout-title">Customize Fleet Columns</strong>
        <p className="tiny muted">
          Choose which columns to show and adjust their display order. Layout preferences are saved
          in this browser.
        </p>

        <div style={{ marginTop: 12 }}>
          {columns.map((col, index) => (
            <div
              key={col.id}
              className="row"
              style={{
                justifyContent: "space-between",
                padding: "6px 8px",
                borderBottom: "1px solid var(--border-subtle, #333)",
                alignItems: "center",
              }}
            >
              <label
                className="row"
                style={{
                  alignItems: "center",
                  gap: 8,
                  margin: 0,
                  cursor: col.canHide ? "pointer" : "default",
                }}
              >
                <input
                  type="checkbox"
                  checked={col.visible}
                  disabled={!col.canHide}
                  onChange={() => toggleColumn(col.id)}
                  aria-label={`Toggle column ${col.label}`}
                />
                <span>{col.label}</span>
                {!col.canHide && <span className="tiny muted">(required)</span>}
              </label>

              <div className="row" style={{ gap: 4 }}>
                <button
                  type="button"
                  className="secondary"
                  style={{ padding: "2px 6px", fontSize: "0.75em" }}
                  disabled={index === 0}
                  onClick={() => moveColumn(index, "up")}
                  aria-label={`Move ${col.label} up`}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="secondary"
                  style={{ padding: "2px 6px", fontSize: "0.75em" }}
                  disabled={index === columns.length - 1}
                  onClick={() => moveColumn(index, "down")}
                  aria-label={`Move ${col.label} down`}
                >
                  ↓
                </button>
              </div>
            </div>
          ))}
        </div>

        <div className="row" style={{ marginTop: 16, justifyContent: "space-between" }}>
          <button type="button" className="secondary" onClick={onReset}>
            Reset to default
          </button>
          <button type="button" className="secondary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Multi-guard policy review report modal (issue #477).
 */
export function PolicyReportModal({ rows, onClose }: { rows: FleetRow[]; onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const report = useMemo(() => generateFleetPolicyReport(rows), [rows]);

  useEffect(() => {
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  const handleDownload = () => {
    const md = formatFleetPolicyReportMarkdown(report);
    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `fleet-policy-report-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="policy-report-title"
        ref={dialogRef}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        style={{ maxWidth: 840, width: "90vw" }}
      >
        <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
          <strong id="policy-report-title">Multi-Guard Policy Review Report</strong>
          <span className="tiny muted">{report.capturedAt}</span>
        </div>

        {report.isPartial && (
          <div className="notice warn" role="alert" style={{ marginTop: 10 }}>
            <strong>Partial Report</strong>
            <span className="tiny">
              {report.failedReads} of {report.totalGuards} guard reads failed. Unread guards are NOT
              empty policies; their policy status cannot be asserted until connectivity is restored.
            </span>
          </div>
        )}

        <div className="row" style={{ marginTop: 8, gap: 16 }}>
          <span className="tiny">
            <strong>Network:</strong> {report.network}
          </span>
          <span className="tiny">
            <strong>Total Guards:</strong> {report.totalGuards}
          </span>
          <span className="tiny">
            <strong>Successful:</strong> {report.successfulReads}
          </span>
          <span className="tiny">
            <strong>Failed:</strong> {report.failedReads}
          </span>
        </div>

        <div className="scrolly" style={{ maxHeight: 300, marginTop: 12 }}>
          <table className="events">
            <thead>
              <tr>
                <th scope="col">Guard</th>
                <th scope="col">Outcome</th>
                <th scope="col">Policy</th>
                <th scope="col">Freeze</th>
                <th scope="col">DMS Grace</th>
              </tr>
            </thead>
            <tbody>
              {report.entries.map((entry) => (
                <tr key={entry.guard}>
                  <td data-label="Guard">
                    <div>
                      <strong>{entry.label}</strong>
                    </div>
                    <div className="mono tiny">{entry.guard}</div>
                  </td>
                  <td data-label="Outcome">
                    {entry.readOutcome === "success" ? (
                      <span className="pill ok">Success</span>
                    ) : (
                      <span className="pill danger" title={entry.error ?? "Failed"}>
                        Read Failed
                      </span>
                    )}
                  </td>
                  <td data-label="Policy" className="tiny">
                    {entry.policySummary}
                  </td>
                  <td data-label="Freeze">
                    {entry.adminFrozen === true ? (
                      <span className="pill danger">Frozen</span>
                    ) : entry.adminFrozen === false ? (
                      <span className="pill ok">Normal</span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td data-label="DMS Grace" className="mono tiny">
                    {entry.dmsGraceSecs ? `${entry.dmsGraceSecs}s` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="row" style={{ marginTop: 16, justifyContent: "space-between" }}>
          <button type="button" className="secondary" onClick={handleDownload}>
            Download Report (.md)
          </button>
          <button type="button" className="secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Register an absent guard into the browser's local registry (issue #478).
 */
export function RegisterGuardModal({
  onClose,
  onRegistered,
}: {
  onClose: () => void;
  onRegistered: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [address, setAddress] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedAddress = address.trim();
    if (!isValidGuardAddress(trimmedAddress)) {
      setError("Invalid Soroban contract address. Must be a valid 56-character C... StrKey.");
      return;
    }
    setError(null);
    rememberInstance(trimmedAddress, label.trim() || defaultGuardLabel(trimmedAddress));
    onRegistered();
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="register-guard-title"
        ref={dialogRef}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        style={{ maxWidth: 520 }}
      >
        <strong id="register-guard-title">Register Deployed Guard</strong>
        <p className="tiny muted" style={{ marginTop: 6, lineHeight: 1.4 }}>
          Fleet membership is browser-local: guards only appear here if registered in this
          browser&apos;s registry. If you deployed a guard via CLI or another machine, register its
          address below to monitor it. Registration saves this address locally; it does NOT deploy,
          verify, or create a contract on-chain.
        </p>

        <form onSubmit={handleSubmit} style={{ marginTop: 12 }}>
          <label className="field">
            <span className="lbl">Guard Contract Address (C...)</span>
            <input
              type="text"
              className="mono"
              placeholder="CAYJZT..."
              value={address}
              onChange={(e) => {
                setAddress(e.target.value);
                setError(null);
              }}
              required
            />
          </label>

          <label className="field" style={{ marginTop: 8 }}>
            <span className="lbl">Label (optional)</span>
            <input
              type="text"
              placeholder="e.g. Production Agent Guard"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </label>

          {error && (
            <div className="notice warn" role="alert" style={{ marginTop: 8 }}>
              <span className="tiny">{error}</span>
            </div>
          )}

          <div className="row" style={{ marginTop: 16, justifyContent: "flex-end", gap: 8 }}>
            <button type="button" className="secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit">Register Guard</button>
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * Preview and confirm merging imported registry entries (issue #479).
 */
export function RegistryMergeModal({
  instances,
  onClose,
  onMerged,
}: {
  instances: readonly GuardInstance[];
  onClose: () => void;
  onMerged: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [inputJson, setInputJson] = useState("");
  const [parseError, setParseError] = useState<string | null>(null);
  const [preview, setPreview] = useState<RegistryMergePreview | null>(null);
  const [conflictChoices, setConflictChoices] = useState<Record<string, boolean>>({});

  useEffect(() => {
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  const handlePreview = () => {
    try {
      const parsed = JSON.parse(inputJson);
      const res = previewRegistryMerge(instances, parsed);
      if (!res.ok) {
        setParseError(res.error ?? "Failed to parse registry merge file.");
        setPreview(null);
        return;
      }
      setParseError(null);
      setPreview(res);
      const defaults: Record<string, boolean> = {};
      for (const c of res.conflicts) {
        defaults[c.guard] = true;
      }
      setConflictChoices(defaults);
    } catch (e) {
      setParseError(e instanceof Error ? e.message : "Invalid JSON input.");
      setPreview(null);
    }
  };

  const handleConfirm = () => {
    if (!preview) return;
    for (const addition of preview.additions) {
      rememberInstance(addition.guard, addition.label);
    }
    for (const conflict of preview.conflicts) {
      if (conflictChoices[conflict.guard]) {
        rememberInstance(conflict.guard, conflict.importedLabel);
      }
    }
    onMerged();
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="registry-merge-title"
        ref={dialogRef}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        style={{ maxWidth: 650, width: "90vw" }}
      >
        <strong id="registry-merge-title">Import &amp; Merge Registry</strong>
        <p className="tiny muted" style={{ marginTop: 4 }}>
          Merge guards into this browser&apos;s local registry. No contracts are deployed or changed
          on-chain. Conflicts require explicit confirmation before changes are applied.
        </p>

        {!preview ? (
          <div style={{ marginTop: 12 }}>
            <label className="field">
              <span className="lbl">Paste Registry JSON or Instances Array</span>
              <textarea
                rows={6}
                className="mono tiny"
                placeholder='[{"guard": "CAYJZT...", "label": "My Guard"}]'
                value={inputJson}
                onChange={(e) => {
                  setInputJson(e.target.value);
                  setParseError(null);
                }}
              />
            </label>

            {parseError && (
              <div className="notice warn" role="alert" style={{ marginTop: 8 }}>
                <span className="tiny">{parseError}</span>
              </div>
            )}

            <div className="row" style={{ marginTop: 16, justifyContent: "flex-end", gap: 8 }}>
              <button type="button" className="secondary" onClick={onClose}>
                Cancel
              </button>
              <button type="button" disabled={!inputJson.trim()} onClick={handlePreview}>
                Preview Merge
              </button>
            </div>
          </div>
        ) : (
          <div style={{ marginTop: 12 }}>
            <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
              <span className="tiny">
                <strong>Additions:</strong> {preview.additions.length}
              </span>
              <span className="tiny">
                <strong>Conflicts:</strong> {preview.conflicts.length}
              </span>
              <span className="tiny">
                <strong>Skipped:</strong> {preview.skips.length}
              </span>
              {preview.invalid.length > 0 && (
                <span className="tiny" style={{ color: "var(--danger, #f87171)" }}>
                  <strong>Invalid:</strong> {preview.invalid.length}
                </span>
              )}
            </div>

            {preview.conflicts.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <strong className="tiny">Conflicts (Select to overwrite existing label):</strong>
                <div className="scrolly" style={{ maxHeight: 120, marginTop: 4 }}>
                  <table className="events">
                    <thead>
                      <tr>
                        <th scope="col">Overwrite</th>
                        <th scope="col">Address</th>
                        <th scope="col">Current Label</th>
                        <th scope="col">Imported Label</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.conflicts.map((c) => (
                        <tr key={c.guard}>
                          <td>
                            <input
                              type="checkbox"
                              checked={conflictChoices[c.guard] ?? false}
                              onChange={(e) =>
                                setConflictChoices((curr) => ({
                                  ...curr,
                                  [c.guard]: e.target.checked,
                                }))
                              }
                              aria-label={`Overwrite ${c.guard}`}
                            />
                          </td>
                          <td className="mono tiny">{c.guard.slice(0, 8)}...</td>
                          <td className="tiny">{c.currentLabel}</td>
                          <td className="tiny">
                            <strong>{c.importedLabel}</strong>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {preview.additions.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <strong className="tiny">New Guards to Add:</strong>
                <div className="scrolly" style={{ maxHeight: 100, marginTop: 4 }}>
                  {preview.additions.map((a) => (
                    <div
                      key={a.guard}
                      className="row tiny"
                      style={{ justifyContent: "space-between", padding: "2px 0" }}
                    >
                      <span>
                        <strong>{a.label}</strong> ({a.network})
                      </span>
                      <span className="mono">{a.guard.slice(0, 12)}...</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {preview.invalid.length > 0 && (
              <div className="notice warn" role="alert" style={{ marginTop: 8 }}>
                <strong className="tiny">Ignored {preview.invalid.length} invalid entries:</strong>
                <ul className="tiny" style={{ margin: "4px 0 0 16px", padding: 0 }}>
                  {preview.invalid.map((inv, idx) => (
                    <li key={idx}>{inv.reason}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="row" style={{ marginTop: 16, justifyContent: "space-between" }}>
              <button type="button" className="secondary" onClick={() => setPreview(null)}>
                Back to Edit
              </button>
              <div className="row" style={{ gap: 8 }}>
                <button type="button" className="secondary" onClick={onClose}>
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleConfirm}
                  disabled={preview.additions.length === 0 && preview.conflicts.length === 0}
                >
                  Confirm Merge (
                  {preview.additions.length + Object.values(conflictChoices).filter(Boolean).length}
                  )
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Read-only fleet risk summary card (issue #475).
 * Aggregates only successful live reads; lists failed/excluded guards explicitly.
 */
export function FleetRiskSummaryCard({
  rows,
  onSelectGuard,
}: {
  rows: FleetRow[];
  onSelectGuard: (address: string) => void;
}) {
  const summary = useMemo(() => computeFleetRiskSummary(rows), [rows]);

  return (
    <div
      className="notice info"
      role="region"
      aria-label="Fleet Risk Summary"
      data-testid="fleet-risk-summary"
      style={{ marginBottom: 14 }}
    >
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <strong>Live Fleet Risk Summary (Read-Only)</strong>
        <span className="tiny muted">
          Aggregated from {summary.successfulReads} successful read
          {summary.successfulReads !== 1 ? "s" : ""}
        </span>
      </div>

      <div
        className="row"
        style={{ gap: 12, marginTop: 8, flexWrap: "wrap", alignItems: "center" }}
      >
        <div
          data-testid="risk-card-frozen"
          className="row"
          style={{ gap: 6, alignItems: "center" }}
        >
          <span className="pill danger tiny">{summary.frozen.length} Frozen</span>
          {summary.frozen.map((item) => (
            <button
              key={item.address}
              type="button"
              className="secondary"
              style={{ padding: "2px 6px", fontSize: "0.75em" }}
              onClick={() => onSelectGuard(item.address)}
              title={`Inspect frozen guard ${item.label}`}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div
          data-testid="risk-card-expired"
          className="row"
          style={{ gap: 6, alignItems: "center" }}
        >
          <span className="pill warn tiny">{summary.expiredDms.length} DMS Expired</span>
          {summary.expiredDms.map((item) => (
            <button
              key={item.address}
              type="button"
              className="secondary"
              style={{ padding: "2px 6px", fontSize: "0.75em" }}
              onClick={() => onSelectGuard(item.address)}
              title={`Inspect expired DMS guard ${item.label}`}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div
          data-testid="risk-card-missing-policy"
          className="row"
          style={{ gap: 6, alignItems: "center" }}
        >
          <span className="pill warn tiny">{summary.missingPolicy.length} Missing Policy</span>
          {summary.missingPolicy.map((item) => (
            <button
              key={item.address}
              type="button"
              className="secondary"
              style={{ padding: "2px 6px", fontSize: "0.75em" }}
              onClick={() => onSelectGuard(item.address)}
              title={`Inspect missing-policy guard ${item.label}`}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div
          data-testid="risk-card-healthy"
          className="row"
          style={{ gap: 6, alignItems: "center" }}
        >
          <span className="pill ok tiny">{summary.activeHealthy.length} Healthy</span>
        </div>
      </div>

      {summary.failedOrExcluded.length > 0 && (
        <div
          data-testid="excluded-guards-list"
          style={{
            marginTop: 8,
            paddingTop: 6,
            borderTop: "1px solid rgba(0,0,0,0.08)",
          }}
        >
          <span className="tiny warn">
            Excluded from live summary ({summary.failedOrExcluded.length} read failed / offline):
          </span>
          <ul className="tiny muted" style={{ margin: "4px 0 0", paddingLeft: 18 }}>
            {summary.failedOrExcluded.map((entry) => (
              <li key={entry.address}>
                <button
                  type="button"
                  style={{
                    background: "none",
                    border: "none",
                    padding: 0,
                    color: "inherit",
                    textDecoration: "underline",
                    cursor: "pointer",
                    fontSize: "inherit",
                  }}
                  onClick={() => onSelectGuard(entry.address)}
                >
                  {entry.label} ({entry.address.slice(0, 8)}…)
                </button>
                {entry.error ? ` — ${entry.error}` : " — read unconfirmed"}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

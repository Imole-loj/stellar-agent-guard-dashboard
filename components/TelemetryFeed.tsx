"use client";

import { memo, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { describeGuardEvent, explainReason, GUARD_EVENT_TOPICS } from "stellar-agent-guard-sdk";
import type { GuardEvent } from "stellar-agent-guard-sdk";
import {
  STREAM_BUFFER_LIMIT,
  describeFeedGap,
  type TelemetryEvent,
} from "../lib/guard/telemetry.ts";
import { useGuard, useGuardEvents } from "./GuardProvider.tsx";
import { TelemetryAlerts } from "./TelemetryAlerts.tsx";
import { TelemetryChart } from "./TelemetryChart.tsx";
import { ErrorBlock, Skeleton, TimeAgo, short, starLink, TxHashCell } from "./bits.tsx";
import { DateRangePicker } from "./DateRangePicker.tsx";
import type { RangePreset, TimeRange } from "../lib/guard/ledgerTime.ts";
import { density, initDensityStore } from "../lib/guard/densityStore.ts";
import {
  NDJSON_MIME,
  auditLogFilename,
  isFilterActive,
  telemetryToAuditLog,
} from "../lib/guard/exportFormats.ts";
import { NETWORK } from "../lib/guard/network.ts";
import { loadScopedValue, saveScopedValue } from "../lib/guard/guardScoped.ts";
import { useAnnounce } from "../lib/guard/useAnnounce.ts";
import { eventsToCsv, eventsToJson, exportFilename } from "../lib/guard/eventExport.ts";
import { buildExportScope, describeExportScope } from "../lib/guard/exportScope.ts";
import { POLL_PHASE_WORDS, type PollPhase } from "../lib/guard/feedHealth.ts";
import {
  markNotStored,
  markRejected,
  markRemoved,
  markSaved,
  streamPaused,
  streamResumed,
  type MarkKind,
} from "../lib/guard/announceCopy.ts";
import {
  EVENT_NOTE_MAX_LENGTH,
  MARKS_ARE_BROWSER_LOCAL,
  eventIdentityOf,
  eventMarks,
  sameMark,
  type EventMark,
  type MarkPatch,
} from "../lib/guard/eventMarks.ts";
import { BlockedEventBadge } from "./BlockedEventBadge.tsx";
import { useDemoMode } from "../lib/guard/useDemoMode.ts";
import {
  EMPTY_TELEMETRY_FILTER,
  filterGuardEvents,
  telemetryToCsv,
  telemetryToNdjson,
  type TelemetryFilter,
  type VerdictFilter,
} from "../lib/guard/telemetryExport.ts";
import { severityFor } from "../lib/guard/feedSeverity.ts";
import { formatEventTimestamp } from "../lib/guard/time.ts";
import { decodeUrlState, writeUrlState } from "../lib/guard/urlState.ts";
import { eventHref, eventLinkTargetFor, writeEventLink } from "../lib/guard/eventLink.ts";
import { EventDetailPanel } from "./EventDetailPanel.tsx";
import {
  FEED_GUARD_CAP,
  attributionLabel,
  matchesGuardFilter,
  toggleGuardFilter,
} from "../lib/guard/feedSubscriptions.ts";

/** The scoped-state base under which each guard's feed filter is remembered. */
const SCOPED_FILTER_BASE = "feedFilter";

/** Human names for the topic filter's options, keyed by the topic symbol. */
const TOPIC_LABELS: Record<string, string> = {
  [GUARD_EVENT_TOPICS.authChecked]: "Authorization decisions",
  [GUARD_EVENT_TOPICS.heartbeat]: "Agent heartbeats",
  [GUARD_EVENT_TOPICS.initialized]: "Account initialized",
  [GUARD_EVENT_TOPICS.frozen]: "Admin freeze",
  [GUARD_EVENT_TOPICS.unfrozen]: "Admin unfreeze",
  [GUARD_EVENT_TOPICS.policySet]: "Policy installed",
  [GUARD_EVENT_TOPICS.policyRevoked]: "Policy revoked",
};

/**
 * Save a text payload as a download.
 *
 * A blob URL with the `download` attribute, not a `data:` URL: the content can
 * be arbitrarily large (10k-event exports) and browsers cap data-URL
 * navigation. Revoking immediately after the click is safe — the browser has
 * already captured the blob by then.
 */
function downloadText(filename: string, content: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * The live event feed.
 *
 * Three things are stated on the panel rather than glossed over, because all three
 * change how the feed should be read:
 *
 *   - Soroban RPC has no push stream, so this polls `getEvents` with a cursor and
 *     the real latency floor is the ledger close interval, not the poll interval.
 *   - A *refused* decision never becomes a transaction: the guard returns `Err`,
 *     which rolls the event back. So the feed can only carry refused decisions
 *     that this console produced itself, decoded from the enforced simulation's
 *     diagnostics and labelled `diagnostic`. Absence of refusals here does not
 *     mean absence of refusals on chain.
 *   - Rows are tiered by severity so a block is findable by looking, not by
 *     reading: the tier is a class and a `data-severity`, and every tier's wording
 *     is already in the row, so nothing here depends on colour.
 *   - Since issue #23 the feed tails *several* guards at once, merging their
 *     streams into one table with a guard-attribution chip per row. Each tailed
 *     guard is one more poll loop, so only the first `FEED_GUARD_CAP` are watched
 *     and the rest are named as not tailed rather than silently dropped.
 *
 * There is deliberately no sound. An operator console runs unattended and muted;
 * a noise that can only be silenced in the tab that made it is not an alert.
 */
export function TelemetryFeed() {
  // The feed subscribes to the events context itself: batches re-render this
  // panel and nothing else (see `GuardEventsContext`).
  const events = useGuardEvents();
  const {
    feed,
    stream,
    pauseStream,
    resumeStream,
    startWatching,
    stopWatching,
    clearEvents,
    guard,
    queryRange,
    rangeLabel,
    exportRange,
    instances,
    tailSelection,
    toggleTailedGuard,
  } = useGuard();
  // Restore a shared verdict filter from the URL, while retaining the other
  // filter dimensions independently for each guard in local storage.
  const [filters, setFilters] = useState<Record<string, TelemetryFilter>>(() => {
    const saved =
      loadScopedValue<TelemetryFilter>(SCOPED_FILTER_BASE, NETWORK.name, guard) ??
      EMPTY_TELEMETRY_FILTER;
    const shared =
      typeof window === "undefined" ? undefined : decodeUrlState(window.location.search).filter;
    return {
      [guard]: shared === undefined ? saved : { ...saved, verdict: shared },
    };
  });
  const filter =
    filters[guard] ??
    loadScopedValue<TelemetryFilter>(SCOPED_FILTER_BASE, NETWORK.name, guard) ??
    EMPTY_TELEMETRY_FILTER;

  function applyFilter(update: (current: TelemetryFilter) => TelemetryFilter) {
    const next = update(filter);
    setFilters((current) => ({ ...current, [guard]: next }));
    saveScopedValue(SCOPED_FILTER_BASE, NETWORK.name, guard, next);
    // Keep the shareable verdict and panel in the URL without navigating.
    writeUrlState({
      filter: next.verdict,
      tab: next.verdict === "all" ? "console" : "telemetry",
    });
  }

  const [densityState, setDensityState] = useState<"comfortable" | "compact">("comfortable");

  useEffect(() => {
    const unsubscribe = initDensityStore();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDensityState(density.get());
    const densityUnsubscribe = density.subscribe((value) => {
      setDensityState(value);
    });
    return () => {
      unsubscribe();
      densityUnsubscribe();
    };
  }, []);

  const announce = useAnnounce();
  const demo = useDemoMode();

  /*
    Operator marks (#482, #483): the bookmark and the note held against each event.

    One subscription at the panel rather than one per row. Rows are memoised and the
    feed holds up to `STREAM_BUFFER_LIMIT` of them, so a per-row subscription would
    mean a hundred listeners re-rendering on every keystroke-sized write, and the
    panel needs the same reading anyway for its counts, its "bookmarked only"
    control and the storage notice. `markFor()` is a cache read, so a row still
    renders only the one mark it owns.

    `observe()` is called from an effect, never during render: reading this browser's
    storage in the render that hydrates server markup is the mismatch this store's
    `getServerSnapshot` exists to avoid, and it is the same rule `fleetTableState.ts`
    states for the fleet table.
  */
  useSyncExternalStore(eventMarks.subscribe, eventMarks.getSnapshot, eventMarks.getServerSnapshot);
  // Every guard that has an event in the buffer, not just the guard on screen: a
  // bookmark made against guard A must still show when the operator is looking at
  // a merged tail of A and B, and it must not be applied to a same-looking event id
  // under guard B. The bucket is chosen from the event's own contract.
  const markedGuards = useMemo(() => {
    const seen = new Set<string>();
    for (const event of events) {
      const identity = eventIdentityOf(event);
      if (identity !== null) seen.add(identity.guard);
    }
    return [...seen];
  }, [events]);

  useEffect(() => {
    eventMarks.observe(markedGuards);
  }, [markedGuards]);

  /**
   * Download the feed through the shared export path (issue #37). The schema,
   * BOM and filename rules all live in `lib/guard/eventExport.ts` — this is a
   * thin binding, not a second exporter.
   *
   * #309: it hands over `scope.rows`, which is the exact array the preview above
   * counted. There is no second selection step, so the count the operator read
   * before clicking cannot differ from the count in the file they got.
   */
  function downloadExport(format: "csv" | "json") {
    const content =
      format === "csv"
        ? eventsToCsv(scope.rows, guard)
        : JSON.stringify(eventsToJson(scope.rows, guard), null, 2);
    const type = format === "csv" ? "text/csv;charset=utf-8" : "application/json";
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = exportFilename(guard, format, scope.rowCount);
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    announce(
      `Exported ${scope.rowCount} event${scope.rowCount === 1 ? "" : "s"} as ${format.toUpperCase()}`,
    );
  }

  // The guard-chip filter (issue #23) is one more feed criterion, composed ahead
  // of the verdict/topic/contract filter rather than instead of it: an empty
  // selection means "every guard", which is the state the panel opens in.
  const [selectedGuards, setSelectedGuards] = useState<Set<string>>(() => new Set());
  // "Bookmarked only" (#482) is a *view* control, ephemeral like the guard chips:
  // it selects which saved rows to show, it is not a property of the event and so
  // it is not part of the persisted `TelemetryFilter` a filter-sharing link can
  // carry. Bookmarking is per-browser; a URL that promised "bookmarked only" would
  // be a promise about rows the recipient has never marked.
  const [bookmarkedOnly, setBookmarkedOnly] = useState(false);
  const guardVisible = useMemo(
    () => events.filter((event) => matchesGuardFilter(event.contractId, selectedGuards)),
    [events, selectedGuards],
  );
  // The three controls, the bookmark view and the exports all act on the same
  // projection, so a CSV/NDJSON download is provably the filtered view on screen —
  // one row in, one line out, never a hidden superset. The guard chip feeds that
  // same projection, so an export is the filtered multi-guard view and nothing
  // more. A bookmark narrows it the same way, and the export preview above the
  // table counts exactly what it left out.
  const byFilter = filterGuardEvents(guardVisible, filter);
  const rows = bookmarkedOnly
    ? byFilter.filter((event) => eventMarks.markFor(event)?.bookmarked === true)
    : byFilter;
  const filterActive = isFilterActive(filter) || selectedGuards.size > 0 || bookmarkedOnly;

  /*
    Two counts, because they answer different questions and conflating them is how
    a saved mark comes to look lost: `marksStored` is everything this browser holds
    for the guards in view, `marksInBuffer` is the subset sitting on events the feed
    still displays. The buffer is capped, so a bookmark on an event that scrolled
    out is saved and simply not showable here — the panel says so rather than
    letting the operator conclude it was deleted.
  */
  const marksStored = markedGuards.reduce(
    (total, address) => total + Object.keys(eventMarks.marksOf(address)).length,
    0,
  );
  const marksInBuffer = events.reduce(
    (total, event) => (eventMarks.markFor(event) === null ? total : total + 1),
    0,
  );
  const marksNotice = eventMarks.notice();

  /**
   * The scope every download leaves with (#309), computed from the same rows the
   * table is showing. Each exporter is handed `scope.rows`, so the range, the
   * count and the "diagnostics included" line in the preview below are statements
   * about the file rather than statements about the screen.
   *
   * Not a `useMemo`: `rows` is a fresh array on every render (it is a filter, not
   * a cached value), so a memo here would recompute anyway and only claim a
   * stabilisation it never provided.
   */
  const scope = buildExportScope({ events: rows, range: exportRange, rangeLabel });

  /**
   * Chips describe what is actually tailed: the live tail's (capped) set while
   * watching, and the full registry otherwise, so the controls never offer a
   * guard the feed is not reading.
   */
  const chipSources = useMemo(
    () =>
      feed.guards.length > 0
        ? feed.guards
        : instances.map((instance) => ({ guard: instance.guard, label: instance.label })),
    [feed.guards, instances],
  );

  /**
   * Download the structured audit log: a header line naming the guard, network
   * and filter, then one record per event with its raw XDR and every 64-bit
   * value as a decimal string. Like the other exports it is the filtered view
   * on screen; the header's `bufferedCount` shows how much the filter left out.
   */
  function exportAuditLog() {
    const exportedAt = new Date();
    const body = telemetryToAuditLog({
      events: scope.rows,
      bufferedCount: events.length,
      guard,
      network: NETWORK.name,
      filter,
      latestLedger: feed.latestLedger,
      demo,
      exportedAt,
    });
    downloadText(
      auditLogFilename(exportedAt, filterActive ? "filtered" : "full"),
      body,
      `${NDJSON_MIME};charset=utf-8`,
    );
    announce(`Exported ${scope.rowCount} event${scope.rowCount === 1 ? "" : "s"} to the audit log`);
  }

  function applyRange(range: TimeRange, preset: RangePreset) {
    // A historical query replaces the live tail view: the feed shows exactly
    // the window asked for, and watching stops so a poll cannot overwrite it.
    stopWatching();
    void queryRange(range, preset);
  }

  function backToLive() {
    clearEvents();
    startWatching();
  }

  /**
   * Pausing and resuming are announced once each, through the shell's polite
   * region, and the count that goes with them is the operator's own number to
   * check the table against.
   *
   * The notice below is deliberately *not* a live region. It carries the queue
   * depth, so as a live region it would re-announce on every event that arrived
   * while the table was frozen — a burst of interruptions for a number that is
   * already on screen. One announcement per transition, and the live number
   * stays where the operator can read it.
   */
  function onPause() {
    pauseStream();
    const spoken = streamPaused();
    announce(spoken.message, spoken.priority);
  }

  function onResume() {
    // Read the depth before the buffer is drained: afterwards it is always zero,
    // and "resumed with 0 queued" is a claim the operator can check against the
    // badge they just watched fill.
    const queued = stream.pendingCount;
    resumeStream();
    const spoken = streamResumed(queued);
    announce(spoken.message, spoken.priority);
  }

  /**
   * Write one half of a mark, then say what happened in the words `announceCopy`
   * owns (#482, #483).
   *
   * Returns the sentence a *rejection* produced, or `null`. The row keeps it to put
   * beside the textarea that caused it: a note editor must not close on a note it
   * did not save, or the operator loses what they typed. A mark that was applied but
   * not stored is deliberately not returned — it is on the row and the editor has
   * nothing left to fix, so the panel's storage notice carries that one instead.
   *
   * Stable across renders, which is what lets the memoised row take it as a prop
   * without defeating its own memoisation.
   */
  const applyMark = useCallback(
    (event: GuardEvent, patch: MarkPatch, kind: MarkKind): string | null => {
      const before = eventMarks.markFor(event);
      const outcome = eventMarks.applyMark(event, patch);
      const anchored = eventIdentityOf(event)?.anchored ?? false;
      if (outcome.ok && sameMark(before, outcome.mark)) {
        // Nothing on the row changed, so nothing is worth interrupting the operator
        // for — and "Note removed" for a note that never existed is not true.
        return null;
      }
      const spoken = !outcome.ok
        ? markRejected(kind, outcome.message)
        : outcome.mark === null
          ? markRemoved(kind)
          : outcome.persisted
            ? markSaved(kind, anchored)
            : markNotStored(
                kind,
                eventMarks.notice()?.message ?? "the browser refused to write it",
              );
      announce(spoken.message, spoken.priority);
      return outcome.ok ? null : spoken.message;
    },
    [announce],
  );

  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>Telemetry</h2>
        <div className="row">
          {feed.watching && (
            <span className={`pill ${feed.health.tone}`}>
              {POLL_PHASE_WORDS[feed.health.phase]}
            </span>
          )}
          {stream.paused && <span className="pill warn">paused</span>}
          {/* Counted from the buffer, not from the rows on screen: a paused,
              filtered or empty table can hide a blocked decision that is plainly
              in the stream, and a count the operator cannot reconcile with the
              feed is worse than no count. */}
          <BlockedEventBadge events={events} />
          {feed.latestLedger !== null && (
            <span className="tiny muted">ledger {feed.latestLedger}</span>
          )}
          {feed.watching ? (
            <button className="secondary" onClick={stopWatching}>
              Stop
            </button>
          ) : (
            <button onClick={startWatching}>Start watching</button>
          )}
          {stream.paused ? (
            <button onClick={onResume}>
              Resume{stream.pendingCount > 0 ? ` (${stream.pendingCount})` : ""}
            </button>
          ) : (
            <button
              className="secondary"
              onClick={onPause}
              disabled={!feed.watching}
              title="Freeze the table so rows stop moving. Polling continues; new events queue until you resume."
            >
              Pause stream
            </button>
          )}
          <button
            className="secondary"
            onClick={clearEvents}
            disabled={events.length === 0}
            title="Empty the list. The poll cursor is kept, so nothing is re-fetched and nothing is skipped."
          >
            Clear buffer
          </button>
          {/* Density toggle */}
          <button
            className="secondary"
            onClick={() => {
              density.set(densityState === "comfortable" ? "compact" : "comfortable");
            }}
          >
            {densityState === "comfortable" ? "Compact" : "Comfortable"}
          </button>
        </div>
      </div>

      {/* Focus from `?event=…`, above the controls rather than below the table: an
          operator arriving from a shared link came for that one row, and the feed
          they land on is empty until someone presses Start watching. */}
      <EventDetailPanel />

      <div style={{ marginTop: 10 }}>
        <DateRangePicker onApply={applyRange} />
        {rangeLabel && (
          <div className="row" style={{ marginTop: 8 }}>
            <span className="pill warn">historical: {rangeLabel}</span>
            <button className="secondary" onClick={backToLive}>
              Back to live tail
            </button>
          </div>
        )}
      </div>

      <div>
        {stream.paused && (
          <div className="notice" style={{ marginTop: 12 }}>
            <strong>
              Stream paused ({stream.pendingCount} new event{stream.pendingCount === 1 ? "" : "s"}{" "}
              pending)
            </strong>
            <span className="tiny">
              The table is frozen so you can read it. Polling carries on in the background and new
              events queue here; resume to add them in order, with no duplicates and none skipped.
              {stream.dropped > 0 &&
                ` ${stream.dropped} older queued event${stream.dropped === 1 ? "" : "s"} fell past the ${STREAM_BUFFER_LIMIT}-event buffer and will not be shown.`}
            </span>
          </div>
        )}
      </div>

      {/*
        What the download is about to contain (#309), stated before the operator
        clicks rather than after. Every number here is read off `scope`, and
        `scope.rows` is the array the exporters are handed — so this is a claim
        about the file, not a restatement of the table. The field list is imported
        from the exporter itself, and the omission of `data` is named because that
        is the one event field that could carry payload material.
      */}
      <div className="notice info" style={{ marginTop: 10 }}>
        <strong>Export scope</strong>
        <ul className="tiny" style={{ margin: "4px 0 0 0", paddingLeft: 18 }}>
          {describeExportScope(scope).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        {scope.excludedByRange > 0 && (
          <span className="tiny">
            {scope.excludedByRange} row(s) you can see are outside the selected range and will not
            be in the file.
          </span>
        )}
      </div>

      <div className="row" style={{ marginTop: 10, flexWrap: "wrap", gap: 8 }}>
        <label
          className="tiny muted"
          style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
        >
          Verdict
          <select
            aria-label="Verdict filter"
            value={filter.verdict}
            onChange={(event) =>
              applyFilter((current) => ({
                ...current,
                verdict: event.target.value as VerdictFilter,
              }))
            }
          >
            <option value="all">All verdicts</option>
            <option value="allowed">Allowed Only</option>
            <option value="blocked">Blocked Only</option>
          </select>
        </label>
        <label
          className="tiny muted"
          style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
        >
          Topic
          <select
            aria-label="Topic filter"
            value={filter.topic}
            onChange={(event) =>
              applyFilter((current) => ({ ...current, topic: event.target.value }))
            }
          >
            <option value="all">All topics</option>
            {Object.entries(TOPIC_LABELS).map(([topic, label]) => (
              <option key={topic} value={topic}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <input
          aria-label="Contract address search"
          placeholder="Contract address contains…"
          value={filter.contract}
          onChange={(event) =>
            applyFilter((current) => ({ ...current, contract: event.target.value }))
          }
          style={{ maxWidth: 240 }}
        />
        <button
          className="secondary"
          onClick={() => downloadExport("csv")}
          disabled={scope.rowCount === 0}
          title="Stable append-only schema (docs/export-schema.md): schema_version, guard, topic, kind, source, decision, reason, reason_label, ledger, ledger_closed_at, transaction_hash — BOM-prefixed for Excel"
        >
          Export CSV
        </button>
        <button
          className="secondary"
          onClick={() => downloadExport("json")}
          disabled={scope.rowCount === 0}
          title="Same schema as the CSV export, as one JSON object: schemaVersion, columns, guard, rows"
        >
          Export JSON
        </button>
        <button
          className="secondary"
          onClick={() =>
            downloadText(
              "guard-telemetry.ndjson",
              telemetryToNdjson(scope.rows),
              "application/x-ndjson",
            )
          }
          disabled={scope.rowCount === 0}
        >
          Export NDJSON
        </button>
        <button
          className="secondary"
          onClick={exportAuditLog}
          disabled={scope.rowCount === 0}
          title="NDJSON audit log: a header line, then decoded fields, verdict, ledger, transaction hash and the raw event XDR per event (terms in docs/glossary.md — XDR, Ledger, Stroop)"
        >
          Export audit log
        </button>
        {filterActive && (
          <button
            className="secondary"
            onClick={() => {
              applyFilter(() => EMPTY_TELEMETRY_FILTER);
              // "Clear filters" clears every criterion, the chip filter and the
              // bookmark view included.
              setSelectedGuards(new Set());
              setBookmarkedOnly(false);
            }}
          >
            Clear filters
          </button>
        )}
      </div>

      {chipSources.length > 1 && (
        <div
          className="row"
          style={{ marginTop: 8, flexWrap: "wrap", gap: 8 }}
          role="group"
          aria-label="Filter events by guard"
        >
          <span className="tiny muted">Filter by guard:</span>
          {chipSources.map((source) => {
            const active = selectedGuards.has(source.guard);
            return (
              <button
                key={source.guard}
                className={active ? "pill ok" : "pill"}
                aria-pressed={active}
                title={source.guard}
                onClick={() =>
                  setSelectedGuards((current) => toggleGuardFilter(current, source.guard))
                }
              >
                {source.label}
              </button>
            );
          })}
          {selectedGuards.size > 0 && (
            <button className="secondary" onClick={() => setSelectedGuards(new Set())}>
              All guards
            </button>
          )}
        </div>
      )}

      {/*
        What this browser holds in marks (#482, #483), stated once for the whole
        feed instead of per row.

        It renders only while something is marked, or while the view is filtered to
        marks. That is the honest condition — there is nothing to report about marks
        that do not exist — and it is also why the console's visual baselines are
        untouched by this feature: a fresh browser, which is what a baseline is
        taken in, renders the panel exactly as it did before. The entry point is the
        per-row control, not this block.

        The two counts are kept apart because conflating them is how a saved mark
        comes to look deleted. The buffer is capped, so a mark on an event that has
        aged out is still stored and simply has no row to sit on here.
      */}
      {(marksStored > 0 || bookmarkedOnly) && (
        <div style={{ marginTop: 8 }} data-testid="marks-panel">
          <label
            className="tiny muted"
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            <input
              type="checkbox"
              checked={bookmarkedOnly}
              onChange={(event) => setBookmarkedOnly(event.target.checked)}
            />
            Bookmarked only ({marksInBuffer} in view)
          </label>
          <p className="tiny muted" style={{ marginTop: 4 }}>
            {marksStored} operator mark{marksStored === 1 ? "" : "s"} saved in this browser for{" "}
            {markedGuards.length} guard{markedGuards.length === 1 ? "" : "s"}; {marksInBuffer} of{" "}
            {marksStored} sit on events this feed still holds, and the rest are on events that have
            aged out of the buffer — saved, not lost. {MARKS_ARE_BROWSER_LOCAL} They are never part
            of an export, a transaction or a webhook payload.
          </p>
          {marksNotice !== null && (
            <div className="notice" role="status" data-testid="marks-storage-notice">
              <strong>Marks in this browser could not be read</strong>
              <span className="tiny">{marksNotice.message}</span>
            </div>
          )}
        </div>
      )}

      <p className="tiny muted" style={{ marginTop: 8 }}>
        Tailed from Soroban RPC&apos;s <code>getEvents</code> with a cursor, so no event is
        delivered twice and none is skipped between polls. Soroban has no push stream — the floor on
        latency is the ledger close interval (roughly 5s), not the 5s poll.
      </p>

      {/*
        Poll liveness, stated separately from the rows below it (#311). This is
        deliberately *not* a live region: it re-renders on every poll, so as a
        live region it would interrupt on each quiet round — announcing "still
        alive" every five seconds. It is plain text with an explicit label, so a
        screen reader gets it on demand, and the one transition that does deserve
        an interruption (a poll beginning to fail) is the error block under it.

        Two stamps are shown because they answer different questions: the last
        round that *returned*, and the last one that was *attempted*. Before #311
        the panel had one field covering both, so "last poll 5s ago" was true of a
        feed whose every poll since the first had failed.
      */}
      <p className="tiny muted" style={{ marginTop: 4 }} aria-label="Telemetry poll health">
        <span className={`pill ${feed.health.tone}`}>{POLL_PHASE_WORDS[feed.health.phase]}</span>{" "}
        {feed.health.text}
        {feed.lastPolledAt && feed.lastPolledAt !== feed.health.lastSuccessAt && (
          <>
            {" "}
            (Last attempt <TimeAgo iso={feed.lastPolledAt} suffix=" ago" />
            .)
          </>
        )}
      </p>

      {feed.guards.length > 0 && (
        <p className="tiny muted" style={{ marginTop: 8 }}>
          Tailing {feed.guards.length} guard{feed.guards.length === 1 ? "" : "s"} simultaneously, up
          to the {FEED_GUARD_CAP}-guard cap. Each tailed guard is its own poll loop, so RPC load
          scales with the number watched.
        </p>
      )}

      {feed.capped > 0 && (
        <div className="notice" role="status">
          <strong>
            {feed.capped} guard{feed.capped === 1 ? "" : "s"} beyond the {FEED_GUARD_CAP}-guard cap{" "}
            {feed.capped === 1 ? "is" : "are"} not being tailed
          </strong>
          <span className="tiny">
            {feed.cappedLabels.join(", ")}. Their events will not appear in this feed. Choose which
            of them to tail below — the cap keeps poll load bounded rather than silently multiplying
            RPC traffic, but which guards it bounds is your decision, not the registry&apos;s order.
          </span>
        </div>
      )}

      {/* Coverage warnings. An empty list means no discontinuity has been detected,
          not that the feed is known to be complete. Nothing here fills a hole with
          invented events: the rows above are only what the RPC returned. */}
      {feed.gaps.map((notice) => (
        <div
          key={notice.guard}
          className={notice.lost.length > 0 ? "notice danger" : "notice"}
          role={notice.lost.length > 0 ? "alert" : "status"}
          data-testid="feed-gap-notice"
        >
          <strong>Possible gaps in the feed for {notice.label}</strong>
          {notice.lost.map((gap) => {
            const text = describeFeedGap(gap);
            return (
              <span className="tiny" key={`${gap.fromLedger}-${gap.toLedger}`}>
                {text.headline}. {text.range}
              </span>
            );
          })}
          {notice.unsettled && (
            <span className="tiny">
              {describeFeedGap(notice.unsettled).headline}.{" "}
              {describeFeedGap(notice.unsettled).range} This clears once a later poll is consistent.
            </span>
          )}
        </div>
      ))}

      {/*
        Which guards spend the capped slots (#310). Every saved guard is listed,
        not just the tailed ones, because the whole point is that the unselected
        set is invisible-but-real: an operator cannot choose to tail a guard they
        cannot see. The active guard is shown as pinned rather than as a checkbox,
        since #23's rule that the guard on screen is never starved outranks a
        selection.
      */}
      <fieldset style={{ marginTop: 10 }}>
        <legend className="tiny muted">
          Guards to tail ({feed.guards.length} of {FEED_GUARD_CAP} slots used)
        </legend>
        <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
          {instances.map((instance) => {
            const chosen = tailSelection.includes(instance.guard);
            const isTailed = feed.guards.some((source) => source.guard === instance.guard);
            const isActive = instance.guard === guard;
            return (
              <label
                key={instance.guard}
                className={`pill${isTailed ? " ok" : " muted"}`}
                style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
                title={`${instance.guard}${isActive ? " — the guard on screen, always tailed" : ""}`}
              >
                <input
                  type="checkbox"
                  aria-label={`Tail ${instance.label}`}
                  checked={isActive || chosen}
                  disabled={isActive}
                  onChange={() => toggleTailedGuard(instance.guard)}
                />
                {instance.label}
                {isActive && <span className="tiny">on screen</span>}
              </label>
            );
          })}
        </div>
        <p className="tiny muted" style={{ marginTop: 6 }}>
          Each tailed guard is its own <code>getEvents</code> poll loop, so {feed.guards.length}{" "}
          listener{feed.guards.length === 1 ? "" : "s"} are live now. Your choice is remembered for{" "}
          {NETWORK.name} only, and only names which guards get the slots — it never changes what the
          chain says about them.
        </p>
      </fieldset>

      <div className="notice info">
        <strong>Refused decisions cannot reach this feed from the ledger</strong>
        <span className="tiny">
          When the guard refuses a call it returns an error, which rolls the event back — so a
          refused decision has no transaction and no committed event. Rows marked{" "}
          <em>diagnostic</em> are the refusals this console produced itself, decoded from the failed
          enforced simulation before broadcast. An empty feed is not evidence that nothing was
          refused on chain.
        </span>
      </div>

      {feed.error && <ErrorBlock title="The event feed could not poll" detail={feed.error} />}

      <TelemetryAlerts />

      <TelemetryChart />

      {events.length === 0 ? (
        feed.watching && feed.latestLedger === null ? (
          /* The initial load: watching has started but the first poll has not
             returned (no ledger cursor yet). This is a pending read, not an
             empty result, so it renders as skeleton rows in the same table
             shape the events will land in — not as an empty-looking message
             and not as zeros. */
          <div className="scrolly table-stack" aria-busy="true">
            <table className={`events stack ${densityState === "compact" ? "compact" : ""}`}>
              {feedHead}
              <tbody aria-hidden="true">
                {[0, 1, 2].map((row) => (
                  <tr key={row}>
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
              </tbody>
            </table>
          </div>
        ) : (
          <p className="tiny muted">
            {feed.watching
              ? feed.guards.length > 1
                ? "No events from these guards yet. Lifecycle events (policy set, frozen, heartbeat) and allowed decisions appear here as they settle."
                : "No events from this guard yet. Lifecycle events (policy set, frozen, heartbeat) and allowed decisions appear here as they settle."
              : feed.guards.length > 1
                ? "Start watching to tail these guards' events."
                : "Start watching to tail this guard's events."}
          </p>
        )
      ) : rows.length === 0 ? (
        <p className="tiny muted">
          No events match the current filter. The feed still holds {guardVisible.length} event(s);
          widen the verdict, topic, contract
          {selectedGuards.size > 0 ? ", guard" : ""}
          {bookmarkedOnly ? " or bookmark" : ""} filter to see them.
        </p>
      ) : (
        <div className="scrolly table-stack">
          <table className={`events stack ${densityState === "compact" ? "compact" : ""}`}>
            {feedHead}
            <tbody>
              {rows.map((event) => (
                <TelemetryRow
                  key={event.id}
                  event={event}
                  guardLabel={attributionLabel(event.contractId, chipSources)}
                  mark={eventMarks.markFor(event)}
                  onMark={applyMark}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="tiny muted" style={{ marginTop: 8 }}>
        Feed holds the most recent {events.length} event(s) from{" "}
        {feed.guards.length > 1 ? (
          `${feed.guards.length} tailed guards`
        ) : (
          <span className="mono">{short(guard, 8, 6)}</span>
        )}
        .{filterActive && <> Showing {rows.length} matching the current filter.</>} The audit log
        keeps 64-bit values (ledgers, stroop amounts, timestamps) as strings so no precision is
        lost.
      </p>
    </div>
  );
}

/**
 * One feed row, memoised.
 *
 * The feed re-renders on every poll batch (and, under the #114 benchmark's
 * injection seam, many times a second), while a row's content is a pure
 * function of its own event. Memoising keeps the cost of a batch proportional
 * to the rows the batch actually added instead of to the feed's whole 250-row
 * cap — the difference between holding frame rate and remounting the table on
 * every update.
 *
 * The key is the SDK's `event.id`, the same identity the feed de-duplicates
 * on, so React reconciles against the same uniqueness the feed guarantees: a new
 * event prepending shifts nothing, and no row is ever unmounted and rebuilt
 * merely because rows above it changed.
 *
 * Severity rides here, on the row's own attributes, so the tier costs no extra
 * element and the cells stay exactly as they were — O(1) from fields the decoder
 * already produced, with no topic or reason string parsed (see `severityFor`).
 *
 * Since #482/#483 the row also renders its operator mark, and that is the one
 * thing here which is not a function of `event` alone. It arrives as a prop for
 * exactly that reason: the panel subscribes to the marks store once, and a row
 * takes the single `EventMark` it displays. The memo still holds, because the
 * store hands out identity-stable mark objects (only the one that changed is
 * replaced) and `onMark` is a `useCallback`, so bookmarking one row re-renders
 * that row and leaves the other 249 alone. A per-row subscription would have
 * meant one listener per row and a re-render of the whole table per keystroke.
 */
const TelemetryRow = memo(function TelemetryRow({
  event,
  guardLabel,
  mark,
  onMark,
}: {
  event: TelemetryEvent;
  /** The registry label for this row's guard, resolved by the caller. */
  guardLabel: string | null;
  /** This row's operator mark, or `null`. Read from the store by the panel. */
  mark: EventMark | null;
  /** Apply one half of the mark; returns a rejection's wording, or `null`. */
  onMark: (event: GuardEvent, patch: MarkPatch, kind: MarkKind) => string | null;
}) {
  // The note editor is row-local on purpose: a draft belongs to the row being
  // annotated, it must not survive a remount of a different row, and lifting it
  // to the panel would re-render all 250 rows on every keystroke.
  const [editingNote, setEditingNote] = useState(false);
  const [draft, setDraft] = useState("");
  const [noteError, setNoteError] = useState<string | null>(null);

  function openNoteEditor(): void {
    setDraft(mark?.note ?? "");
    setNoteError(null);
    setEditingNote(true);
  }

  function closeNoteEditor(): void {
    setEditingNote(false);
    setDraft("");
    setNoteError(null);
  }

  function saveNote(): void {
    const rejected = onMark(event, { note: draft }, "note");
    // Only a refusal keeps the editor open: closing it on an unsaved note would
    // discard what the operator just typed.
    if (rejected === null) closeNoteEditor();
    else setNoteError(rejected);
  }

  const severity = severityFor(event);
  const iso = event.ledgerClosedAt ?? event.observedAt ?? null;
  // Derived from the row's own event, so the permalink costs no new prop and the
  // memoisation above stays exactly as it was. Null for a refusal and for a row the
  // console could not address, and those rows render no affordance rather than a
  // link that would fail to re-read (see `eventLinkTargetFor`).
  const focus = eventLinkTargetFor(event);
  const href = focus === null ? null : eventHref(focus.guard, focus.raw);
  const permalink = focus !== null && href !== null ? { locator: focus.raw, href } : null;
  // Both renderings of the same instant: the local wall time with an explicit
  // zone label for at-a-glance reading, and the stable UTC value to quote in a
  // report. The UTC value comes from the parsed instant, so it is unaffected
  // by this operator's zone or by DST; invalid timestamps yield null and the
  // cell falls back to the relative time plus `—`.
  const timestamp = formatEventTimestamp(iso);
  // Whether this row can hold a mark at all: no emitting contract, or a diagnostic
  // that arrived without the SDK's content-hashed id, and there is nothing to key
  // one on (`eventIdentityOf` is what the store itself refuses on).
  const rowIdentity = eventIdentityOf(event);
  return (
    <tr className={`severity-${severity}`} data-severity={severity} data-stream={event.source}>
      <td data-label="Event">
        {/* The severity tier is already colour-coded by the row class; this is the
            same fact as text, so reduced-motion or monochrome reading keeps it. */}
        <span className="visually-hidden">Severity: {severity}. </span>
        <div>{labelFor(event)}</div>
        <div className="tiny muted mono">{describeGuardEvent(event)}</div>
        {permalink !== null && (
          <a
            className="tiny"
            href={permalink.href}
            data-testid="event-permalink"
            title="Focus this event. Opens a detail re-read from the chain, and puts a link to this exact row in the address bar."
            onClick={(click) => {
              // Plain navigation would reload the page and take the feed, the
              // wallet session and any form draft with it. `replaceState` focuses
              // the row in place; a modified click (new tab) still navigates.
              if (click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) return;
              click.preventDefault();
              writeEventLink(permalink.locator);
            }}
          >
            link to this row
          </a>
        )}
        {/*
          The operator's own marks (#482, #483).

          Both controls are offered on every row the feed can identify, marked or
          not: a bookmark is how a mark comes to exist, so an affordance that only
          appeared once the first one did would be undiscoverable. A row with no
          stable identity shows the reason instead of a button, because the refusal
          it would produce is otherwise something only a screen reader hears. What
          is *not* offered on any row is a re-read promise — a bookmarked
          diagnostic says "no ledger to re-read this from" rather than linking to a
          ledger that never held it.
        */}
        {rowIdentity === null ? (
          <div className="tiny muted" data-testid="mark-unavailable" style={{ marginTop: 4 }}>
            <span
              className="pill"
              title="A mark is keyed on the event's own id. This row never carried one and has no ledger entry to reconstruct it from, so a bookmark would attach to the wrong event or to none."
            >
              unidentifiable
            </span>{" "}
            nothing to save a mark against
          </div>
        ) : (
          <div className="row" style={{ gap: 6, marginTop: 4, flexWrap: "wrap" }}>
            <button
              className="secondary"
              aria-pressed={mark?.bookmarked ?? false}
              title="Bookmark this event in this browser. A bookmark is yours, not the guard's, and no export carries it."
              onClick={() =>
                onMark(event, { bookmarked: !(mark?.bookmarked ?? false) }, "bookmark")
              }
            >
              {mark?.bookmarked ? "Bookmarked" : "Bookmark"}
            </button>
            <button
              className="secondary"
              onClick={() => (editingNote ? closeNoteEditor() : openNoteEditor())}
              title="Add a private note about this event, stored in this browser only."
            >
              {editingNote ? "Close note" : mark?.note ? "Edit note" : "Note"}
            </button>
          </div>
        )}
        {mark !== null && (
          <div className="tiny muted" data-testid="mark-indicator" style={{ marginTop: 2 }}>
            <span className="pill warn" title={MARKS_ARE_BROWSER_LOCAL}>
              browser-local
            </span>{" "}
            {mark.bookmarked ? "bookmarked" : "noted"}
            {mark.note !== "" && <>: {mark.note}</>}
          </div>
        )}
        {editingNote && (
          <div style={{ marginTop: 4 }}>
            <textarea
              aria-label="Note for this event, stored in this browser only"
              className="tiny"
              rows={2}
              maxLength={EVENT_NOTE_MAX_LENGTH}
              value={draft}
              onChange={(change) => setDraft(change.target.value)}
              style={{ width: "100%", boxSizing: "border-box" }}
            />
            <div className="row" style={{ gap: 6, marginTop: 4, flexWrap: "wrap" }}>
              <button onClick={saveNote}>Save note</button>
              <button className="secondary" onClick={closeNoteEditor}>
                Cancel
              </button>
            </div>
            <p className="tiny muted" style={{ marginTop: 2 }}>
              {draft.length}/{EVENT_NOTE_MAX_LENGTH} characters. Saving an empty note removes it.
              Stored in this browser only: never exported, never sent to the network, never part of
              a transaction.
            </p>
            {noteError !== null && (
              <p className="tiny" role="alert" data-testid="note-error">
                {noteError}
              </p>
            )}
          </div>
        )}
      </td>
      <td data-label="Decision">
        {event.decision ? (
          event.decision.result === "blocked" ? (
            <span className="pill danger">{event.decision.reason ?? "blocked"}</span>
          ) : (
            <span className="pill ok">allowed</span>
          )
        ) : (
          <span className="muted tiny">—</span>
        )}
        {event.decision?.result === "blocked" && event.decision.reason && (
          <div className="tiny muted">{explainReason(event.decision.reason)}</div>
        )}
      </td>
      <td data-label="Guard">
        {guardLabel !== null ? (
          <span className="pill" title={event.contractId ?? "unknown contract"}>
            {guardLabel}
          </span>
        ) : (
          <span className="tiny muted">—</span>
        )}
      </td>
      <td data-label="Source">
        <span className={`pill${event.source === "diagnostic" ? " warn" : ""}`}>
          {event.source}
        </span>
      </td>
      <td className="mono tiny" data-label="Time">
        {iso ? <TimeAgo iso={iso} /> : "—"}
        {timestamp && (
          <div
            className="muted"
            style={{ marginTop: 2 }}
            title={`${timestamp.local} ${timestamp.zoneLabel} · ${timestamp.utc} UTC`}
          >
            {timestamp.local} {timestamp.zoneLabel}
            <br />
            {timestamp.utc} UTC
          </div>
        )}
        {event.ledger ? (
          <div className="muted" style={{ marginTop: 2 }}>
            L{event.ledger}
          </div>
        ) : null}
      </td>
      <td data-label="Transaction">
        {event.transactionHash ? (
          <TxHashCell hash={event.transactionHash} />
        ) : (
          <span className="tiny muted">none — never broadcast</span>
        )}
      </td>
    </tr>
  );
});

const feedHead = (
  <thead>
    <tr>
      <th scope="col">Event</th>
      <th scope="col">Decision</th>
      <th scope="col">Guard</th>
      <th scope="col">Source</th>
      <th scope="col">Time</th>
      <th scope="col">Transaction</th>
    </tr>
  </thead>
);

function labelFor(event: GuardEvent): string {
  switch (event.kind) {
    case "auth_checked":
      return "Authorization decision";
    case "heartbeat":
      return "Agent heartbeat";
    case "initialized":
      return "Account initialized";
    case "frozen":
      return "Admin freeze";
    case "unfrozen":
      return "Admin unfreeze";
    case "policy_set":
      return "Policy installed";
    case "policy_revoked":
      return "Policy revoked";
    default:
      return event.topic;
  }
}

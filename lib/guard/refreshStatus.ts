/**
 * Which panels are polling, how often, and when they last landed (#528).
 *
 * The console already reported this per panel: the telemetry header says
 * "polling", the status panel says when it last read. What it did not have was
 * one place an operator could look, on any screen, to see the whole picture
 * before deciding whether a number on screen is current. That is what the header
 * strip renders, and what this module feeds it.
 *
 * **The rule it exists to enforce: polling is not activity.** A panel can be
 * refreshing on schedule and still show nothing (a quiet guard), and a panel can
 * have stopped refreshing while its last read sits on screen looking current.
 * #311 settled that for the feed, in `pollHealth()`; this module borrows that
 * verdict rather than inventing a second one, and adds only what a header needs:
 * the cadence the console was configured with, and whether the operator froze
 * the display.
 *
 * So a source reports the axes and nothing derived:
 *
 *   - `watching`  - is this panel's poller running at all,
 *   - `polling`   - is a round in flight right now,
 *   - `lastSuccessAt` / `lastFailureAt` - when each last happened,
 *   - `paused`    - is the *display* frozen while the poller carries on.
 *
 * `paused` travels apart from `watching` on purpose. Telemetry's freeze stops
 * rows moving while its poll keeps running; reporting that by flipping `watching`
 * would be the exact conflation the other axes exist to prevent, so the strip
 * says both.
 *
 * Cadence splits in two for the same reason. `intervalMs` is the period the
 * poller's timer actually runs on - `jitteredInterval()` spreads reloads across
 * the last fifth of a cycle - and the overdue window has to match the panel's own
 * window or the two surfaces disagree about whether a feed is dead. What the
 * strip *shows* is the configured `POLLING.*` value from `REFRESH_PANELS`, worded
 * as an approximation, because "every 5 seconds" is a promise the code does not
 * make.
 *
 * Nothing here reads the chain. Panels push what they already know; the header
 * reads it. A panel that unmounts retires its source, so the strip can never
 * show a poller that stopped when its screen went away - and a poller that is not
 * reading the chain at all (demo mode's fixtures) withholds its source rather
 * than publishing one, so the strip never lends fixture data the authority of a
 * chain read.
 */

import { OVERDUE_INTERVALS, POLL_PHASE_WORDS, pollHealth, type PollPhase } from "./feedHealth.ts";
import { POLLING } from "./polling.ts";
import { sinceWords } from "./time.ts";

/** The panels with a chain poller behind them. */
export type RefreshPanelId = "status" | "telemetry" | "fleet";

/**
 * What one panel says about its own refreshing.
 *
 * Every field is required, including the `null`s: an absent stamp means "never",
 * and a missing one means the panel forgot to say. Two different answers that an
 * optional field would let a caller collapse into one.
 *
 * The panel's *name* and its cadence are deliberately absent. They are fixed per
 * panel and live in `REFRESH_PANELS`, so the header cannot name a panel something
 * its own heading does not say, and a poller cannot mistype a constant it has no
 * reason to know.
 */
export interface RefreshSource {
  id: RefreshPanelId;
  /**
   * The period this poller's timer runs on. It sets the overdue window, so it has
   * to be the same value the panel's own health reading used.
   */
  intervalMs: number;
  /** Whether the poller is running. `false` is "stopped", not "quiet". */
  watching: boolean;
  /** Whether a round is in flight right now. */
  polling: boolean;
  /** ISO time of the last round that returned. Never written on failure. */
  lastSuccessAt: string | null;
  /** ISO time of the last round attempted, success or not. Dates a failure. */
  lastAttemptAt: string | null;
  /** ISO time of the last round that failed, if any. */
  lastFailureAt: string | null;
  /** The most recent round's error text, or null when it succeeded. */
  error: string | null;
  /**
   * What the last successful round delivered: events for the feed, one state read
   * for the status panel, rows for the fleet. May legitimately be 0.
   */
  deliveredInLastRound: number;
  /** The display is frozen while the poller carries on (telemetry's pause). */
  paused: boolean;
}

/** The fixed description of a panel that polls, keyed by its own panel id. */
export interface RefreshPanelInfo {
  /** The panel's name, exactly as its own heading names it. */
  label: string;
  /** The configured interval the strip states, before jitter shortens it. */
  cadenceMs: number;
  /** Where the operator goes to read the detail behind this line. */
  href: string;
  /** What is there, so the link is named before it is followed. */
  diagnostics: string;
}

export const REFRESH_PANELS: Record<RefreshPanelId, RefreshPanelInfo> = {
  // The `?tab=` links are the deep link this console already answers with
  // (`urlState.ts`, restored by `useRestoreSharedPanelTab`): it brings the panel
  // into view *and moves focus to its heading*, which a bare `#anchor` cannot do
  // for a panel that is not mounted yet on the page being navigated to.
  status: {
    label: "On-chain state",
    cadenceMs: POLLING.snapshotMs,
    href: "/?tab=status",
    diagnostics: "the failed read and its retry",
  },
  telemetry: {
    label: "Telemetry",
    cadenceMs: POLLING.feedMs,
    href: "/?tab=telemetry",
    diagnostics: "poll health, gaps and the feed error",
  },
  fleet: {
    label: "Fleet Overview",
    cadenceMs: POLLING.fleetMs,
    href: "/?tab=fleet",
    diagnostics: "each guard's own read failure",
  },
};

/** A source rendered: the same facts, in the operator's words. */
export interface RefreshReading {
  id: RefreshPanelId;
  label: string;
  phase: PollPhase;
  /** The phase short enough for a header, shared with the feed's own pill. */
  phaseWords: string;
  tone: "ok" | "warn" | "danger" | "muted";
  cadence: string;
  freshness: string;
  /** The freshness stamp as an ISO time, so the phrase can carry a real `<time>`. */
  freshnessIso: string | null;
  /** Stated beside the phase, never instead of it: a frozen display still polls. */
  pausedWords: string | null;
  /**
   * Why the phase is what it is, in the few words a header has room for. Set for
   * the two phases an operator has to act on, and nowhere else.
   *
   * Composed here rather than lifted from `pollHealth()`, because that sentence is
   * the feed's ("events stopped arriving") and a header row about a status read
   * would be describing the wrong thing with it.
   */
  detail: string | null;
  diagnosticsHref: string;
  diagnosticsLabel: string;
}

/** How the console spells a configured cadence. */
export function cadenceWords(intervalMs: number): string {
  const seconds = Math.round(intervalMs / 1000);
  if (seconds < 1) return "less than once a second";
  if (seconds < 60) return `about every ${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.round(seconds / 60);
  return `about every ${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/**
 * One row of the header strip.
 *
 * Pure and clock-injected: freshness and the overdue verdict both depend on when
 * you ask, and a component that re-derived them on its own schedule would
 * disagree with the panel below it by however long its last render took.
 */
export function describeRefresh(source: RefreshSource, nowMs: number): RefreshReading {
  const panel = REFRESH_PANELS[source.id];
  const health = pollHealth({
    watching: source.watching,
    polling: source.polling,
    lastSuccessAt: source.lastSuccessAt,
    lastAttemptAt: source.lastAttemptAt,
    lastFailureAt: source.lastFailureAt,
    error: source.error,
    eventsInLastRound: source.deliveredInLastRound,
    nowMs,
    intervalMs: source.intervalMs,
  });

  let freshness = "never read";
  let freshnessIso: string | null = null;
  if (health.lastSuccessAt !== null) {
    freshness = `read ${sinceWords(Date.parse(health.lastSuccessAt), nowMs)}`;
    freshnessIso = health.lastSuccessAt;
  } else if (health.lastFailureAt !== null) {
    freshness = "no successful read yet";
  }

  let detail: string | null = null;
  if (health.phase === "failing") {
    // The round-trip error beats a generic sentence: it is the one line that says
    // *why*, and the panel below may have already cleared its copy of it.
    detail = source.error ?? "the last poll failed";
  } else if (health.phase === "overdue") {
    detail = `no successful read in ${OVERDUE_INTERVALS} intervals`;
  }

  return {
    id: source.id,
    label: panel.label,
    phase: health.phase,
    phaseWords: POLL_PHASE_WORDS[health.phase],
    tone: health.tone,
    cadence: cadenceWords(panel.cadenceMs),
    freshness,
    freshnessIso,
    pausedWords: source.paused ? "display paused" : null,
    detail,
    diagnosticsHref: panel.href,
    diagnosticsLabel: `${panel.label}: see ${panel.diagnostics}`,
  };
}

export interface RefreshSourceRegistry {
  /** Record what a panel now knows. An unchanged report does not wake listeners. */
  publish(source: RefreshSource): void;
  /** Drop a panel - called when its poller unmounts, so the strip stays honest. */
  retire(id: RefreshPanelId): void;
  subscribe(listener: () => void): () => void;
  getSnapshot(): readonly RefreshSource[];
  getServerSnapshot(): readonly RefreshSource[];
}

/** Field-wise equality, so a poller that re-reports the same facts is a no-op. */
function sameSource(a: RefreshSource, b: RefreshSource): boolean {
  return (
    a.id === b.id &&
    a.intervalMs === b.intervalMs &&
    a.watching === b.watching &&
    a.polling === b.polling &&
    a.lastSuccessAt === b.lastSuccessAt &&
    a.lastAttemptAt === b.lastAttemptAt &&
    a.lastFailureAt === b.lastFailureAt &&
    a.error === b.error &&
    a.deliveredInLastRound === b.deliveredInLastRound &&
    a.paused === b.paused
  );
}

/** The order the strip lists panels in: the console's own reading order. */
const PANEL_ORDER: readonly RefreshPanelId[] = ["status", "telemetry", "fleet"];

/**
 * A registry of the pollers currently running in this tab.
 *
 * `useSyncExternalStore` requires a stable snapshot, so the array is rebuilt only
 * when a report actually changes. A poller re-publishing the facts it published a
 * moment ago must not re-render the header, and a fresh array identity on every
 * call would put the app into a render loop.
 */
export function createRefreshSourceRegistry(): RefreshSourceRegistry {
  const EMPTY: readonly RefreshSource[] = [];
  const sources = new Map<RefreshPanelId, RefreshSource>();
  const listeners = new Set<() => void>();
  let snapshot: readonly RefreshSource[] = EMPTY;

  const rebuild = (): void => {
    snapshot = [...sources.values()].sort(
      (a, b) => PANEL_ORDER.indexOf(a.id) - PANEL_ORDER.indexOf(b.id),
    );
  };

  return {
    publish(source) {
      const previous = sources.get(source.id);
      if (previous !== undefined && sameSource(previous, source)) return;
      sources.set(source.id, source);
      rebuild();
      for (const listener of [...listeners]) listener();
    },
    retire(id) {
      if (!sources.delete(id)) return;
      rebuild();
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    // No panel has polled on the server, and the first client paint has not
    // either; both render nothing, so nothing can mismatch on hydration.
    getServerSnapshot: () => EMPTY,
  };
}

/** The tab's registry. Panels publish into it; the header strip reads it. */
export const refreshSources = createRefreshSourceRegistry();

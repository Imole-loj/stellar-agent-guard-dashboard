"use client";

import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";
import { describeRefresh, refreshSources } from "../lib/guard/refreshStatus.ts";

/**
 * How often the strip re-reads its own clock (#528).
 *
 * Freshness is a comparison against now, so a strip that only re-rendered when a
 * poll landed would freeze at "read 4s ago" and quietly turn a live panel into
 * what looks like a dead one. The interval only has to be finer than the fastest
 * cadence it reports; anything below the poll interval itself costs nothing,
 * because a tick with no new facts re-renders one small list.
 */
const CLOCK_TICK_MS = 5000;

/**
 * The header strip: what is polling, how often, when it last landed, and whether
 * the operator froze it.
 *
 * It renders on every screen, above the panels, because the question it answers -
 * "is what I'm looking at current?" - is asked before the operator has scrolled to
 * the panel that would tell them.
 *
 * Three rules it is built to keep:
 *
 *   - **Polling and activity stay separate.** A row says the phase
 *     (`stopped`/`connecting`/`polling`/`poll failing`/`no response`, the same
 *     words the feed's own pill uses) *and*, when the display is frozen, says so
 *     beside it. A frozen feed still polls, and a row that showed only "paused"
 *     would hide the failure arriving underneath.
 *   - **Nothing is invented.** A row exists only while a poller is publishing. The
 *     console's screens each mount their own provider, so leaving a screen retires
 *     its rows and the strip cannot advertise a timer that stopped.
 *   - **It never announces itself.** A 5s tick inside a live region would interrupt
 *     a screen reader several times a minute, so there is no `aria-live` and no
 *     `role="status"` here. The strip is positioned content the operator reads on
 *     demand; the panel's own alerts stay the announced channel.
 *   - **It takes its line before it has anything to say.** Rows only exist after
 *     hydration, but the page around them is in the served HTML. A strip that grew
 *     with them would push every panel down the moment the timers mounted, which
 *     is a layout shift on the largest block on the screen. `.refresh-strip` holds
 *     exactly one line in the served markup, at any width, so the header is the
 *     same height before the rows arrive as after.
 */
export function HeaderRefreshStatus() {
  const sources = useSyncExternalStore(
    refreshSources.subscribe,
    refreshSources.getSnapshot,
    refreshSources.getServerSnapshot,
  );
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const readings = sources.map((source) => describeRefresh(source, nowMs));

  return (
    <div className="refresh-strip">
      {readings.length > 0 && (
        <ul className="refresh-status" aria-label="Panel refresh status">
          {readings.map((reading) => (
            <li key={reading.id} className="refresh-row">
              <Link href={reading.diagnosticsHref} aria-label={reading.diagnosticsLabel}>
                {reading.label}
              </Link>
              <span className={`pill ${reading.tone}`}>{reading.phaseWords}</span>
              <span className="refresh-cadence">{reading.cadence}</span>
              {reading.freshnessIso === null ? (
                <span className="refresh-freshness">{reading.freshness}</span>
              ) : (
                <time className="refresh-freshness" dateTime={reading.freshnessIso}>
                  {reading.freshness}
                </time>
              )}
              {reading.pausedWords !== null && (
                <span className="pill warn">{reading.pausedWords}</span>
              )}
              {reading.detail !== null && <span className="refresh-detail">{reading.detail}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

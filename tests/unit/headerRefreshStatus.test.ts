/**
 * The header refresh strip (issue #528).
 *
 * The strip is the console's only statement about *time* that sits above every
 * panel, so these tests pin the three ways such a statement can be quietly
 * wrong:
 *
 *   - **Polling conflated with activity.** A round that landed and returned
 *     nothing is not a fault, and a poller that stopped is not merely quiet.
 *     #311 fixed this for the feed; the strip inherits the fix through
 *     `pollHealth()` rather than re-deciding it, and the phase tests below hold
 *     it to that.
 *   - **A frozen display read as a stopped poller.** Telemetry's pause stops
 *     rows moving while its poll carries on. Both facts have to survive into the
 *     reading, which is why `paused` is its own axis and its own assertion.
 *   - **A cadence the code does not promise.** The timer is jittered, so the
 *     strip says "about every 15 seconds" from the configured value while the
 *     overdue window uses the panel's actual period. Those two numbers are
 *     allowed to differ, and a test that asserted they matched would be wrong.
 *
 * The component tests then check the accessibility decision rather than merely
 * the markup: the strip is deliberately *not* a live region, because it moves on
 * a five-second clock and a live region would interrupt a screen reader several
 * times a minute to say nothing had changed.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, before, describe, test } from "node:test";
import type { ReactElement } from "react";
import { installDom, loadReact, type Act } from "./domHarness.ts";
import {
  REFRESH_PANELS,
  cadenceWords,
  createRefreshSourceRegistry,
  describeRefresh,
  refreshSources,
  type RefreshSource,
} from "../../lib/guard/refreshStatus.ts";
import { OVERDUE_INTERVALS, POLL_PHASE_WORDS, type PollPhase } from "../../lib/guard/feedHealth.ts";
import { POLLING } from "../../lib/guard/polling.ts";
import { HeaderRefreshStatus } from "../../components/HeaderRefreshStatus.tsx";

installDom();

let react: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let act: Act;

before(async () => {
  const loaded = await loadReact();
  react = loaded.react;
  createRoot = loaded.createRoot;
  act = loaded.act;
});

// ── Fixtures ────────────────────────────────────────────────────────────────

/** A fixed clock, so every age below is exact rather than "whenever this ran". */
const T0 = Date.UTC(2026, 10, 23, 12, 0, 0);

const iso = (msBeforeT0: number): string => new Date(T0 - msBeforeT0).toISOString();

/** A status panel mid-flight: watching, on schedule, one snapshot in hand. */
function source(overrides: Partial<RefreshSource> = {}): RefreshSource {
  return {
    id: "status",
    intervalMs: POLLING.snapshotMs,
    watching: true,
    polling: false,
    lastSuccessAt: iso(3_000),
    lastAttemptAt: null,
    lastFailureAt: null,
    error: null,
    deliveredInLastRound: 1,
    paused: false,
    ...overrides,
  };
}

const reading = (overrides: Partial<RefreshSource> = {}) => describeRefresh(source(overrides), T0);

// ── polling is not activity ─────────────────────────────────────────────────

describe("the phase a panel reports", () => {
  test("a round that landed and returned nothing is healthy, not a fault", () => {
    const row = reading({ deliveredInLastRound: 0 });
    assert.equal(row.phase, "healthy");
    assert.equal(row.tone, "ok");
    // The whole point: an empty round must not acquire an explanation.
    assert.equal(row.detail, null);
  });

  test("a poller that stopped says so even with a fresh read on screen", () => {
    // The failure mode #311 was written about, in the header's words. A stamp
    // from three seconds ago is still a stamp from a poller that is gone.
    const row = reading({ watching: false });
    assert.equal(row.phase, "off");
    assert.equal(row.phaseWords, POLL_PHASE_WORDS.off);
    assert.equal(row.tone, "muted");
    assert.equal(row.freshness, "read just now");
  });

  test("a failed round outranks the success it followed", () => {
    const row = reading({ lastFailureAt: iso(1_000), error: "Horizon 504" });
    assert.equal(row.phase, "failing");
    assert.equal(row.tone, "danger");
    assert.equal(row.detail, "Horizon 504");
  });

  test("a success newer than the failure is recovery, not a second fault", () => {
    const row = reading({
      lastSuccessAt: iso(1_000),
      lastFailureAt: iso(60_000),
      error: "Horizon 504",
    });
    assert.equal(row.phase, "healthy");
    assert.equal(row.detail, null);
  });

  test("a failure with no error text still says which round failed", () => {
    const row = reading({ lastFailureAt: iso(1_000), error: null });
    assert.equal(row.phase, "failing");
    assert.equal(row.detail, "the last poll failed");
  });

  test("three missed intervals is overdue and says how it was judged", () => {
    const row = reading({ lastSuccessAt: iso(POLLING.snapshotMs * (OVERDUE_INTERVALS + 1)) });
    assert.equal(row.phase, "overdue");
    assert.equal(row.tone, "warn");
    assert.match(row.detail ?? "", new RegExp(String(OVERDUE_INTERVALS)));
  });

  test("a round in flight with nothing landed yet is connecting, not healthy", () => {
    const row = reading({ lastSuccessAt: null, polling: true });
    assert.equal(row.phase, "pending");
    assert.equal(row.tone, "warn");
  });
});

// ── the display freeze is a separate fact ───────────────────────────────────

describe("a frozen display", () => {
  test("is stated beside the phase rather than instead of it", () => {
    const row = reading({ paused: true });
    // Pause stops rows *moving*. The poll is still running, and the strip has to
    // be able to say both at once — flipping the phase would be the conflation.
    assert.equal(row.phase, "healthy");
    assert.equal(row.pausedWords, "display paused");
  });

  test("adds nothing when the display is live", () => {
    assert.equal(reading({ paused: false }).pausedWords, null);
  });

  test("does not excuse an overdue poll", () => {
    const row = reading({ paused: true, lastSuccessAt: iso(POLLING.feedMs * 10) });
    assert.equal(row.phase, "overdue");
    assert.equal(row.pausedWords, "display paused");
  });
});

// ── freshness ───────────────────────────────────────────────────────────────

describe("the freshness phrase", () => {
  test("carries the stamp as a machine time only when there is one", () => {
    const live = reading();
    assert.equal(live.freshness, "read just now");
    assert.equal(live.freshnessIso, iso(3_000));
    assert.equal(reading({ lastSuccessAt: null }).freshnessIso, null);
  });

  test("spells an age without saying it twice", () => {
    // `formatTimeAgo` answers "40s" for 40 seconds and "just now" under ten.
    // The strip must not append " ago" to the second of those.
    assert.equal(reading({ lastSuccessAt: iso(40_000) }).freshness, "read 40s ago");
    assert.equal(reading({ lastSuccessAt: iso(3_000) }).freshness, "read just now");
  });

  test("tells 'never polled' apart from 'polled, always failed'", () => {
    assert.equal(reading({ lastSuccessAt: null, lastFailureAt: null }).freshness, "never read");
    assert.equal(
      reading({ lastSuccessAt: null, lastFailureAt: iso(2_000) }).freshness,
      "no successful read yet",
    );
  });
});

// ── cadence ─────────────────────────────────────────────────────────────────

describe("the cadence", () => {
  test("is an approximation of the configured interval", () => {
    assert.equal(cadenceWords(15_000), "about every 15 seconds");
    assert.equal(cadenceWords(1_000), "about every 1 second");
    assert.equal(cadenceWords(60_000), "about every 1 minute");
    assert.equal(cadenceWords(150_000), "about every 3 minutes");
    // Rounded, not truncated: half a second is stated as the nearest whole
    // second, and only a sub-half-second cadence is called what it is.
    assert.equal(cadenceWords(500), "about every 1 second");
    assert.equal(cadenceWords(200), "less than once a second");
  });

  test("is the configured value even when the timer runs on a jittered one", () => {
    // The panel's overdue window uses its real, shortened period; the header
    // states the schedule the console was configured with. Asserting these are
    // the same number would assert a bug.
    const row = reading({ intervalMs: 13_100 });
    assert.equal(row.cadence, `about every ${POLLING.snapshotMs / 1000} seconds`);
  });
});

// ── the vocabulary and the links ────────────────────────────────────────────

describe("POLL_PHASE_WORDS", () => {
  test("names every phase, because the feed pill and the strip read from it", () => {
    const phases: PollPhase[] = ["off", "pending", "healthy", "failing", "overdue"];
    for (const phase of phases) {
      const words = POLL_PHASE_WORDS[phase];
      assert.ok(words.length > 0, `${phase} needs words for a header`);
      // A header pill is one breath: no sentences in here.
      assert.ok(words.length <= 14, `${phase} is spelled too long for a pill`);
    }
    assert.deepEqual(Object.keys(POLL_PHASE_WORDS).sort(), [...phases].sort());
  });
});

describe("each panel's link", () => {
  test("goes to the tab the console already answers with", () => {
    for (const [id, panel] of Object.entries(REFRESH_PANELS)) {
      assert.equal(panel.href, `/?tab=${id}`);
      assert.ok(panel.label.length > 0);
      assert.ok(panel.diagnostics.length > 0, `${id} must say what is behind its link`);
    }
  });

  test("is named before the operator follows it", () => {
    const row = reading();
    assert.equal(row.diagnosticsHref, REFRESH_PANELS.status.href);
    assert.equal(
      row.diagnosticsLabel,
      `${REFRESH_PANELS.status.label}: see ${REFRESH_PANELS.status.diagnostics}`,
    );
  });
});

// ── the registry ────────────────────────────────────────────────────────────

describe("the source registry", () => {
  test("serves an empty, stable snapshot before any panel reports", () => {
    const registry = createRefreshSourceRegistry();
    assert.deepEqual(registry.getSnapshot(), []);
    assert.equal(registry.getSnapshot(), registry.getSnapshot());
    // Hydration renders nothing on either side, so it cannot mismatch.
    assert.deepEqual(registry.getServerSnapshot(), []);
    assert.equal(registry.getServerSnapshot(), registry.getServerSnapshot());
  });

  test("does not wake a listener for a report that changed nothing", () => {
    const registry = createRefreshSourceRegistry();
    const first = source();
    registry.publish(first);
    let wakes = 0;
    registry.subscribe(() => {
      wakes += 1;
    });
    const before = registry.getSnapshot();
    registry.publish(source());
    assert.equal(wakes, 0, "an identical report must not re-render the header");
    assert.equal(registry.getSnapshot(), before, "the snapshot identity has to survive");
    registry.publish(source({ polling: true }));
    assert.equal(wakes, 1);
    assert.notEqual(registry.getSnapshot(), before);
  });

  test("retires a panel and keeps the console's own reading order", () => {
    const registry = createRefreshSourceRegistry();
    registry.publish(source({ id: "fleet" }));
    registry.publish(source({ id: "status" }));
    registry.publish(source({ id: "telemetry" }));
    assert.deepEqual(
      registry.getSnapshot().map((s) => s.id),
      ["status", "telemetry", "fleet"],
    );
    registry.retire("fleet");
    assert.deepEqual(
      registry.getSnapshot().map((s) => s.id),
      ["status", "telemetry"],
    );
    // Retiring something already gone is not a change.
    let wakes = 0;
    registry.subscribe(() => {
      wakes += 1;
    });
    registry.retire("fleet");
    assert.equal(wakes, 0);
  });
});

// ── the component ───────────────────────────────────────────────────────────

/**
 * Every root still standing, so a failure part-way through a test cannot leave
 * one mounted. The strip installs a five-second interval; an un-unmounted one is
 * an event loop that never drains, which turns a red assertion into a hung suite.
 */
const mounted: { unmount: () => Promise<void> }[] = [];

afterEach(async () => {
  while (mounted.length > 0) await mounted.pop()?.unmount();
  for (const id of ["status", "telemetry", "fleet"] as const) refreshSources.retire(id);
  document.body.innerHTML = "";
});

async function renderStrip(): Promise<{
  container: HTMLElement;
  unmount: () => Promise<void>;
}> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(react.createElement(HeaderRefreshStatus as unknown as () => ReactElement));
  });
  const handle = {
    container,
    unmount: async () => {
      const at = mounted.indexOf(handle);
      if (at >= 0) mounted.splice(at, 1);
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
  mounted.push(handle);
  return handle;
}

/** Stamps relative to the wall clock, because the component reads `Date.now()`. */
const live = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString();

describe("the header strip", () => {
  test("says nothing until a poller reports", async () => {
    const { container, unmount } = await renderStrip();
    assert.equal(container.querySelector(".refresh-status"), null);
    await unmount();
  });

  test("renders one row per polling panel, each linking to its own diagnostics", async () => {
    refreshSources.publish(source({ id: "status", lastSuccessAt: live(3_000) }));
    refreshSources.publish(
      source({ id: "telemetry", intervalMs: POLLING.feedMs, lastSuccessAt: live(3_000) }),
    );
    const { container, unmount } = await renderStrip();
    const rows = container.querySelectorAll(".refresh-row");
    assert.equal(rows.length, 2);
    const links = [...container.querySelectorAll<HTMLAnchorElement>(".refresh-row > a")];
    assert.deepEqual(
      links.map((a) => a.getAttribute("href")),
      [REFRESH_PANELS.status.href, REFRESH_PANELS.telemetry.href],
    );
    // Named links: "Telemetry: see poll health, gaps and the feed error", so a
    // screen-reader list of the page's links says what each one is for.
    assert.equal(
      links[1]?.getAttribute("aria-label"),
      reading({ id: "telemetry" }).diagnosticsLabel,
    );
    await unmount();
  });

  test("states the phase in a pill whose class carries the tone", async () => {
    refreshSources.publish(source({ lastSuccessAt: live(1_000), lastFailureAt: live(500) }));
    const { container, unmount } = await renderStrip();
    const pill = container.querySelector(".refresh-row .pill");
    assert.ok(pill);
    assert.equal(pill?.textContent, POLL_PHASE_WORDS.failing);
    assert.match(pill?.className ?? "", /\bdanger\b/);
    assert.equal(container.querySelector(".refresh-detail")?.textContent, "the last poll failed");
    await unmount();
  });

  test("says paused beside polling rather than instead of it", async () => {
    refreshSources.publish(
      source({
        id: "telemetry",
        intervalMs: POLLING.feedMs,
        lastSuccessAt: live(2_000),
        paused: true,
      }),
    );
    const { container, unmount } = await renderStrip();
    const pills = [...container.querySelectorAll(".refresh-row .pill")].map((p) => p.textContent);
    assert.deepEqual(pills, [POLL_PHASE_WORDS.healthy, "display paused"]);
    await unmount();
  });

  test("gives a real <time> to a read it can date and a plain span to one it cannot", async () => {
    refreshSources.publish(source({ lastSuccessAt: live(3_000) }));
    const { container, unmount } = await renderStrip();
    assert.ok(container.querySelector("time.refresh-freshness[datetime]"));
    await unmount();

    refreshSources.publish(source({ lastSuccessAt: null }));
    const second = await renderStrip();
    assert.equal(second.container.querySelector("time"), null);
    assert.equal(second.container.querySelector(".refresh-freshness")?.textContent, "never read");
    await second.unmount();
  });

  test("drops a row the moment its panel unmounts", async () => {
    refreshSources.publish(source({ id: "status", lastSuccessAt: live(3_000) }));
    refreshSources.publish(source({ id: "fleet", lastSuccessAt: live(3_000) }));
    const { container, unmount } = await renderStrip();
    assert.equal(container.querySelectorAll(".refresh-row").length, 2);
    // Leaving `/fleet` stops that poller; a strip still quoting its cadence would
    // be describing a timer that no longer exists.
    await act(async () => {
      refreshSources.retire("fleet");
    });
    assert.equal(container.querySelectorAll(".refresh-row").length, 1);
    assert.equal(
      container.querySelector(".refresh-row > a")?.textContent,
      REFRESH_PANELS.status.label,
    );
    await unmount();
  });

  test("is never a live region", async () => {
    // The strip re-renders every five seconds whether or not anything changed.
    // In an aria-live region that is an announcement every five seconds, which
    // is worse than the silence this replaces.
    refreshSources.publish(source({ lastSuccessAt: live(3_000), paused: true }));
    const { container, unmount } = await renderStrip();
    assert.ok(container.querySelector(".refresh-status"));
    assert.equal(container.querySelector("[aria-live]"), null);
    assert.equal(container.querySelector('[role="status"]'), null);
    assert.equal(container.querySelector('[role="alert"]'), null);
    await unmount();
  });

  test("keeps the strip reachable to a screen reader as a labelled list", async () => {
    refreshSources.publish(source({ lastSuccessAt: live(3_000) }));
    const { container, unmount } = await renderStrip();
    const list = container.querySelector("ul.refresh-status");
    assert.equal(list?.getAttribute("aria-label"), "Panel refresh status");
    assert.equal(list?.querySelector("li")?.tagName, "LI");
    await unmount();
  });

  test("holds its line before a panel publishes anything", async () => {
    // A row can only exist after hydration, while the panels it sits above are in
    // the served HTML. A strip sized to its rows would grow the header the moment
    // the first poller mounted and push every panel down the screen, so the slot
    // renders empty and the sheet gives it the height the rows will need.
    const { container, unmount } = await renderStrip();
    const slot = container.querySelector(".refresh-strip");
    assert.ok(slot, "an empty strip still occupies its line");
    assert.equal(slot?.querySelector(".refresh-status"), null);
    assert.equal(slot?.querySelectorAll(".refresh-row").length, 0);
    await unmount();
  });

  test("fills the slot it reserved instead of trading it for a new box", async () => {
    const { container, unmount } = await renderStrip();
    const before = container.querySelector(".refresh-strip");
    await act(async () => {
      refreshSources.publish(source({ lastSuccessAt: live(3_000) }));
    });
    assert.equal(container.querySelector(".refresh-strip"), before);
    assert.ok(before?.querySelector(".refresh-row"));
    await unmount();
  });
});

// ── the line the sheet reserves ─────────────────────────────────────────────

/*
 * jsdom has no layout engine, so what a test can pin here is the wiring the shift
 * depends on: the slot reserves a height, the list refuses to wrap, and a row can
 * neither shrink nor outgrow the line. `responsiveContract.test.ts` reads the
 * stylesheet the same way for the same reason. The layout itself is proved by the
 * Lighthouse run over the static export, quoted in the PR.
 */
const stylesheet = readFileSync("app/globals.css", "utf8");

function rule(selector: string): string {
  const match = stylesheet.match(new RegExp(`\\.${selector}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `expected a .${selector} rule in globals.css`);
  return match[1] ?? "";
}

describe("the sheet holds the header at one height", () => {
  test("the slot claims a line of its own before a row exists", () => {
    const strip = rule("refresh-strip");
    assert.match(strip, /flex-basis:\s*100%/);
    assert.match(strip, /min-height:\s*var\(--refresh-line-h\)/);
  });

  test("one line is all the strip gets, so a crowded strip scrolls instead of growing", () => {
    assert.match(rule("refresh-status"), /flex-wrap:\s*nowrap/);
    assert.match(rule("refresh-strip"), /overflow-x:\s*auto/);
    // A row allowed to shrink would be squeezed by its siblings and re-measure on
    // every clock tick; one allowed to wrap would grow the header.
    assert.match(rule("refresh-row"), /flex:\s*0 0 auto/);
    assert.match(rule("refresh-row"), /white-space:\s*nowrap/);
  });
});

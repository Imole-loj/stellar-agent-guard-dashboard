/**
 * Pause and resume on the telemetry feed, end to end (issue #487).
 *
 * The unit tests around `StreamBuffer` already prove the pure part: pausing
 * freezes `rows` and parks arrivals in `pending`, resuming prepends them. What
 * only a browser can prove is the three operator-visible promises the issue is
 * actually about, because each one can be broken by the wiring rather than the
 * buffer:
 *
 *   1. Pause clears nothing. Not the rows, not the filter, and not the poll
 *      cursor — the cursor is the one with no on-screen symptom at all, since a
 *      reset cursor re-reads events the feed has already seen and the de-dupe
 *      hides the damage. It is asserted against the RPC mock's counters.
 *   2. The panel says the stream is paused, and still says when the last
 *      successful poll was. "Frozen" and "dead" look identical otherwise.
 *   3. Resume delivers every queued event, in the order they arrived, once each.
 *
 * The mock chain holds 50 events and every tailed guard drains it on its first
 * poll, so after that the only way a row can appear is an injection through
 * `window.__guardFeedInject` — the dev-only seam that calls the same `pushEvents`
 * the poll does. That makes the event counts below exact rather than racy.
 */

import { expect, test, type Page } from "@playwright/test";
import type { GuardEvent } from "stellar-agent-guard-sdk";
import { installSorobanRpcMock } from "./sorobanRpcMock.ts";
import { installFreighterMock } from "./walletMock.ts";
import {
  MIXED_FEED_COUNTS,
  MIXED_FEED_TOTAL,
  fixtureTxHash,
  mixedTelemetryEvents,
  specToGuardEvent,
  throughputTelemetryEvents,
} from "../mocks/eventFixtures.ts";

/** The console's default guard, and the one the feed tails in this test. */
const WATCHED_GUARD = "CAYJZT4XH5SWDXNR7MZJCCUBIDAT2KZDDUTZ7OZQEMKCPJGD4P3X4CU7";

/** How many events arrive while the table is frozen. */
const QUEUED_COUNT = 7;

/** The ledger the queued stream starts at, above the mocked chain's last event. */
const QUEUED_BASE_LEDGER = 6_000_000;

/**
 * Scope every assertion to the feed panel.
 *
 * The dashboard grid wraps each panel in its own container and more than one
 * carries a "Telemetry" heading, so this stays on the panel that owns the table.
 */
function feed(page: Page) {
  return page
    .locator("div.panel")
    .filter({ has: page.getByRole("heading", { name: "Telemetry", exact: true }) });
}

function rows(page: Page) {
  return feed(page).locator("table.events tbody tr");
}

/**
 * The ledger each rendered row displays, top row first.
 *
 * Read in one pass: 57 separate `textContent` round-trips over CDP cost more
 * than the assertion they serve and add nothing to it.
 */
async function visibleLedgers(page: Page): Promise<number[]> {
  return feed(page)
    .locator('table.events tbody tr td[data-label="Time"]')
    .evaluateAll((cells) =>
      cells.map((cell) => {
        const match = /L(\d+)/.exec(cell.textContent ?? "");
        if (match === null) throw new Error(`a feed row showed no ledger: ${cell.textContent}`);
        return Number(match[1]);
      }),
    );
}

/** Push events in through the same write path an RPC poll uses. */
async function inject(page: Page, events: GuardEvent[]): Promise<void> {
  await page.evaluate((incoming) => {
    const scope = window as typeof window & {
      __guardFeedInject?: (events: GuardEvent[]) => void;
    };
    if (typeof scope.__guardFeedInject !== "function") {
      throw new Error("the dev-only feed injection seam is not live");
    }
    scope.__guardFeedInject(incoming);
  }, events);
}

/** How many guards the panel says it is tailing — the RPC arithmetic depends on it. */
async function tailedGuardCount(page: Page): Promise<number> {
  const announcement = feed(page).getByText(/Tailing \d+ guards? simultaneously/);
  await expect(announcement).toBeVisible();
  const matched = /Tailing (\d+) guards?/.exec((await announcement.textContent()) ?? "");
  expect(matched, "the panel must announce how many guards it is tailing").not.toBeNull();
  return Number(matched![1]);
}

test.describe("telemetry feed: pause and resume", () => {
  test("pausing freezes rows, filter and cursor; resume drains the queue in order", async ({
    page,
  }) => {
    test.setTimeout(180_000);

    await installFreighterMock(page);
    const chain = await installSorobanRpcMock(page, { events: mixedTelemetryEvents() });

    await page.goto("/");
    await feed(page).getByRole("button", { name: "Start watching" }).click();
    await expect(rows(page)).toHaveCount(MIXED_FEED_TOTAL, { timeout: 30_000 });

    // The last successful poll is named before the pause, and again after it:
    // the line is what tells an operator a frozen table is still being fed.
    const health = feed(page).getByLabel("Telemetry poll health");
    await expect(health).toContainText("Last successful poll");

    // Every tailed guard reads the whole page once, so `deliveredEvents` has a
    // known value to freeze against. Waiting for it is also what makes the
    // cursor assertion below mean something: an empty later poll is only proof
    // of an untouched cursor if the first poll is accounted for.
    const tailed = await tailedGuardCount(page);
    const drained = MIXED_FEED_TOTAL * tailed;
    await expect.poll(() => chain.deliveredEvents, { timeout: 30_000 }).toBe(drained);

    // ── Pause with a filter applied ────────────────────────────────────────
    await feed(page).getByLabel("Verdict filter").selectOption("blocked");
    await expect(rows(page)).toHaveCount(MIXED_FEED_COUNTS.blocked);

    await feed(page).getByRole("button", { name: "Pause stream" }).click();

    // Status, loudly, in two places: the header pill and the notice.
    await expect(feed(page).getByText("paused", { exact: true })).toBeVisible();
    await expect(feed(page)).toContainText("Stream paused (0 new events pending)");

    // Nothing was cleared. The rows are the 10 blocked decisions, still there,
    // and the filter select still holds the operator's choice.
    await expect(rows(page)).toHaveCount(MIXED_FEED_COUNTS.blocked);
    await expect(feed(page).getByLabel("Verdict filter")).toHaveValue("blocked");
    await expect(health).toContainText("Last successful poll");

    // Polling carries on, and carries on from the same cursor. The poll count
    // rising proves the loop never stopped; the delivered count staying at the
    // drained total proves no poll re-read the page it had already consumed —
    // which is exactly what a reset cursor would do, and what the de-duped
    // table would hide.
    const pollsAtPause = chain.eventPolls;
    await expect.poll(() => chain.eventPolls, { timeout: 30_000 }).toBeGreaterThan(pollsAtPause);
    expect(chain.deliveredEvents).toBe(drained);

    // ── Events arrive while the table is frozen ────────────────────────────
    // Back to the full view first, so the row arithmetic below is exact; the
    // filter is a view over the buffer, not part of what pause protects.
    await feed(page).getByLabel("Verdict filter").selectOption("all");
    await expect(rows(page)).toHaveCount(MIXED_FEED_TOTAL);

    // Ledgers above the mocked chain's last event, so a row carrying one of
    // them can only have come from here and the post-resume order is a plain
    // descending list.
    const queued = throughputTelemetryEvents(QUEUED_COUNT, QUEUED_BASE_LEDGER).map((spec, index) =>
      specToGuardEvent(
        {
          ...spec,
          // A committed event's feed-side id is anchored on its transaction
          // hash, and `throughputTelemetryEvents` reuses the mixed fixture's
          // first hashes — so without transactions of its own this batch
          // would arrive already-seen, and pause would queue two events
          // rather than seven.
          transactionHash: spec.transactionHash === null ? null : fixtureTxHash(1_000 + index),
        },
        WATCHED_GUARD,
      ),
    );
    // One at a time: a single batch would only prove the buffer keeps an array
    // in order, and the operator-visible claim is about arrival order across
    // the whole pause.
    for (const event of queued) {
      await inject(page, [event]);
    }

    await expect(feed(page)).toContainText("Stream paused (7 new events pending)");
    await expect(feed(page).getByRole("button", { name: "Resume (7)" })).toBeVisible();
    // Queued, not shown: the frozen table still holds exactly what it held.
    await expect(rows(page)).toHaveCount(MIXED_FEED_TOTAL);
    expect(chain.deliveredEvents).toBe(drained);

    // ── Resume ─────────────────────────────────────────────────────────────
    await feed(page).getByRole("button", { name: "Resume (7)" }).click();

    await expect(feed(page).getByText("paused", { exact: true })).toHaveCount(0);
    await expect(feed(page)).not.toContainText("Stream paused");
    await expect(rows(page)).toHaveCount(MIXED_FEED_TOTAL + QUEUED_COUNT);

    // Every queued event landed, once, above the events that were already on
    // screen, newest first — the order the live tail would have shown them in.
    await expect
      .poll(async () => (await visibleLedgers(page)).slice(0, QUEUED_COUNT))
      .toEqual(
        Array.from(
          { length: QUEUED_COUNT },
          (_, index) => QUEUED_BASE_LEDGER + QUEUED_COUNT - 1 - index,
        ),
      );
    const ledgers = await visibleLedgers(page);
    expect(ledgers.length).toBe(MIXED_FEED_TOTAL + QUEUED_COUNT);
    expect(ledgers[QUEUED_COUNT]!).toBeLessThan(QUEUED_BASE_LEDGER);
    expect(new Set(ledgers).size).toBe(MIXED_FEED_TOTAL + QUEUED_COUNT);

    // Re-queueing the same events after a resume cannot duplicate a row: the
    // pause consumed their identities into `seen`, not into the visible rows.
    await inject(page, queued);
    await expect(rows(page)).toHaveCount(MIXED_FEED_TOTAL + QUEUED_COUNT);

    // And the health line still reports the poll loop, not the queue.
    await expect(health).toContainText("Last successful poll");
  });
});

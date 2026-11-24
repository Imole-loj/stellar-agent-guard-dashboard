import assert from "node:assert/strict";
import { before, beforeEach, describe, test } from "node:test";
import type { ReactElement } from "react";
import { GUARD_EVENT_TOPICS } from "stellar-agent-guard-sdk";
import type { GuardEvent } from "stellar-agent-guard-sdk";
import { installDom, loadReact, sleep, type Act } from "./domHarness.ts";
import { withIdentity } from "../mocks/eventFixtures.ts";
import { TelemetryFeed } from "../../components/TelemetryFeed.tsx";
import { GuardContext, GuardEventsContext } from "../../components/GuardProvider.tsx";
import { POLL_OFF, pollHealth } from "../../lib/guard/feedHealth.ts";
import { clearAnnouncements, pendingAnnouncements } from "../../lib/guard/useAnnounce.ts";
import { EVENT_NOTE_MAX_LENGTH, eventMarks } from "../../lib/guard/eventMarks.ts";

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

const GUARD_A = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const GUARD_B = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const GUARD_C = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

/** A pinned clock for the health cases, so "ago" wording is exact. */
const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);
const INTERVAL = 5_000;

function isoAt(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

function healthOf(overrides: Record<string, unknown> = {}) {
  return pollHealth({
    watching: true,
    polling: false,
    lastSuccessAt: isoAt(-2_000),
    lastAttemptAt: isoAt(-2_000),
    lastFailureAt: null,
    error: null,
    eventsInLastRound: 0,
    nowMs: NOW,
    intervalMs: INTERVAL,
    ...overrides,
  });
}

function event(contractId: string, ledger: number | null, blocked: boolean): GuardEvent {
  return withIdentity({
    kind: "auth_checked",
    topic: GUARD_EVENT_TOPICS.authChecked,
    source: blocked ? "diagnostic" : "ledger",
    contractId,
    ledger,
    ledgerClosedAt: new Date().toISOString(),
    transactionHash: blocked ? null : `tx-${contractId.slice(0, 4)}`,
    decision: {
      result: blocked ? "blocked" : "allowed",
      reason: blocked ? "per_tx_cap_exceeded" : null,
      source: blocked ? "diagnostic" : "ledger",
    },
    data: {},
  });
}

/**
 * The merged multi-guard tail: one allowed committed row from Guard A and one
 * blocked diagnostic row from Guard B, so attribution and the chip filter each
 * have something to discriminate.
 */
const FEED_EVENTS = [event(GUARD_A, 100, false), event(GUARD_B, null, true)];

/**
 * The feed slice of the context. Split out so a test can move one field (the
 * health reading, the tailed set) without restating the whole feed.
 */
function feedState(overrides: Record<string, unknown> = {}) {
  return {
    watching: true,
    latestLedger: 100,
    error: null,
    lastPolledAt: isoAt(-2_000),
    guards: [
      { guard: GUARD_A, label: "Guard A" },
      { guard: GUARD_B, label: "Guard B" },
    ],
    capped: 1,
    cappedLabels: ["Guard C"],
    health: POLL_OFF,
    /** #308: the panel maps this, so a fixture without it renders nothing. */
    gaps: [],
    ...overrides,
  };
}

function contextValue(
  overrides: Record<string, unknown> = {},
  feedOverrides: Record<string, unknown> = {},
) {
  return {
    server: new Proxy({}, { get: () => () => Promise.reject(new Error("no network in tests")) }),
    wallet: null,
    walletError: null,
    connecting: false,
    connect: async () => {},
    disconnect: () => {},
    signer: () => {
      throw new Error("no signing in feed tests");
    },
    instances: [
      { guard: GUARD_A, label: "Guard A", provenance: "test" },
      { guard: GUARD_B, label: "Guard B", provenance: "test" },
      { guard: GUARD_C, label: "Guard C", provenance: "test" },
    ],
    guard: GUARD_A,
    selectGuard: () => {},
    addInstance: () => {},
    snapshot: null,
    snapshotError: null,
    refreshing: false,
    refresh: async () => {},
    stream: { paused: false, pendingCount: 0, dropped: 0 },
    pauseStream: () => {},
    resumeStream: () => {},
    queryRange: async () => {},
    rangeLabel: null,
    feed: feedState(feedOverrides),
    startWatching: () => {},
    stopWatching: () => {},
    tailSelection: [],
    toggleTailedGuard: () => {},
    exportRange: null,
    clearEvents: () => {},
    pushEvents: () => {},
    notifyTabs: () => {},
    ...overrides,
  } as any;
}

async function renderFeed(
  overrides: Record<string, unknown> = {},
  feedOverrides: Record<string, unknown> = {},
  events = FEED_EVENTS,
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: ReturnType<typeof createRoot> | undefined;
  await act(async () => {
    root = createRoot(container);
    const element: ReactElement = react.createElement(TelemetryFeed);
    // Two contexts, not one: the panel reads its rows through
    // `GuardEventsContext`, which the provider keeps deliberately separate from
    // the guard session. An `events` field on the guard context would look
    // right and render nothing.
    root.render(
      react.createElement(
        GuardContext.Provider,
        { value: contextValue(overrides, feedOverrides) },
        react.createElement(GuardEventsContext.Provider, { value: events }, element),
      ),
    );
  });
  await act(async () => {
    await sleep(40);
  });
  return {
    container,
    unmount: async () => {
      await act(async () => {
        root?.unmount();
      });
      container.remove();
    },
  };
}

function rows(container: HTMLElement): HTMLTableRowElement[] {
  return Array.from(container.querySelectorAll<HTMLTableRowElement>("table.events tbody tr"));
}

test("the feed names the guards beyond the cap instead of dropping them silently", async () => {
  const rendered = await renderFeed();
  try {
    const text = rendered.container.textContent ?? "";
    assert.match(text, /1 guard beyond the 5-guard cap is not being tailed/);
    assert.match(text, /Guard C/, "the un-tailed guard is named");
  } finally {
    await rendered.unmount();
  }
});

test("every row carries a guard-attribution chip from the registry label", async () => {
  const rendered = await renderFeed();
  try {
    const table = rendered.container.querySelector("table.events");
    assert.ok(table, "the feed table renders");
    const body = rows(rendered.container);
    assert.equal(body.length, 2);
    const renderedText = body.map((row) => row.textContent ?? "").join(" | ");
    assert.match(renderedText, /Guard A/);
    assert.match(renderedText, /Guard B/);
  } finally {
    await rendered.unmount();
  }
});

test("the guard-chip filter narrows the merged feed without dropping the others", async () => {
  const rendered = await renderFeed();
  try {
    assert.equal(rows(rendered.container).length, 2);

    const chip = Array.from(rendered.container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Guard B",
    );
    assert.ok(chip, "a filter chip for Guard B must exist");
    await act(async () => {
      chip.click();
    });

    const filtered = rows(rendered.container);
    assert.equal(filtered.length, 1);
    assert.match(filtered[0]?.textContent ?? "", /Guard B/);
    assert.equal(chip.getAttribute("aria-pressed"), "true");

    // Toggling the chip off restores the untailed rows.
    await act(async () => {
      chip.click();
    });
    assert.equal(rows(rendered.container).length, 2);
  } finally {
    await rendered.unmount();
  }
});

/*
 * ---------------------------------------------------------------------------
 * Issues #309, #310 and #311 — the panel's own behaviour on top of the three
 * new modules. The modules are unit-tested directly; these cases pin that the
 * operator actually sees the distinction each one computes.
 * ---------------------------------------------------------------------------
 */

function textOf(container: HTMLElement, selector: string): string {
  return container.querySelector(selector)?.textContent ?? "";
}

function healthLine(container: HTMLElement): Element | null {
  return container.querySelector('[aria-label="Telemetry poll health"]');
}

function buttonByText(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === label,
  );
}

function tailCheckbox(container: HTMLElement, label: string): HTMLInputElement | undefined {
  return (
    container.querySelector<HTMLInputElement>(`input[aria-label="Tail ${label}"]`) ?? undefined
  );
}

describe("poll health is shown apart from event activity (issue #311)", () => {
  test("a failed poll is named as a failure and never as a quiet guard", async () => {
    const rendered = await renderFeed(
      {},
      {
        error: "getEvents timed out",
        lastPolledAt: isoAt(-5_000),
        health: healthOf({
          lastSuccessAt: isoAt(-60_000),
          lastAttemptAt: isoAt(-5_000),
          lastFailureAt: isoAt(-5_000),
          error: "getEvents timed out",
        }),
      },
    );
    try {
      const line = healthLine(rendered.container);
      assert.ok(line, "the panel must state poll liveness in its own element");
      assert.equal(line.getAttribute("aria-label"), "Telemetry poll health");
      assert.match(line.textContent ?? "", /last poll failed/);
      assert.doesNotMatch(line.textContent ?? "", /which is normal for a quiet guard/);
      assert.match(
        textOf(rendered.container, '[aria-label="Telemetry poll health"] .pill'),
        /poll failing/,
      );
      assert.equal(line.querySelector(".pill")?.className, "pill danger");
      assert.match(
        rendered.container.textContent ?? "",
        /could not poll/,
        "the error block is shown too",
      );
    } finally {
      await rendered.unmount();
    }
  });

  test("an empty table under a healthy poll is explained as a quiet guard, not a fault", async () => {
    const rendered = await renderFeed({}, { health: healthOf({ eventsInLastRound: 0 }) });
    try {
      const text = healthLine(rendered.container)?.textContent ?? "";
      assert.match(text, /returned no events/);
      assert.match(text, /normal for a quiet guard/);
      assert.doesNotMatch(text, /failed|not updating|No poll has landed/);
      assert.equal(healthLine(rendered.container)?.querySelector(".pill")?.className, "pill ok");
    } finally {
      await rendered.unmount();
    }
  });

  test("a feed that stopped answering says so, and says it while the table still looks empty", async () => {
    const rendered = await renderFeed(
      {},
      { health: healthOf({ lastSuccessAt: isoAt(-90_000) }) },
      [],
    );
    try {
      assert.equal(rows(rendered.container).length, 0, "the table is empty either way");
      assert.match(healthLine(rendered.container)?.textContent ?? "", /No poll has landed for/);
    } finally {
      await rendered.unmount();
    }
  });

  test("the last attempt is shown separately from the last success, and only when they differ", async () => {
    const diverging = await renderFeed(
      {},
      {
        lastPolledAt: isoAt(-5_000),
        health: healthOf({
          lastSuccessAt: isoAt(-90_000),
          lastFailureAt: isoAt(-5_000),
          error: "500",
        }),
      },
    );
    try {
      assert.match(
        diverging.container.textContent ?? "",
        /Last attempt/,
        "an attempt stamp is offered because it is not the success stamp",
      );
    } finally {
      await diverging.unmount();
    }

    const agreeing = await renderFeed(
      {},
      { lastPolledAt: isoAt(-2_000), health: healthOf({ lastSuccessAt: isoAt(-2_000) }) },
    );
    try {
      assert.doesNotMatch(
        agreeing.container.textContent ?? "",
        /Last attempt/,
        "when the last round both started and succeeded, one sentence is enough",
      );
    } finally {
      await agreeing.unmount();
    }
  });

  test("a stopped feed says it is not watching, and the live pill leaves the header", async () => {
    const rendered = await renderFeed(
      {},
      { watching: false, health: POLL_OFF, guards: [], capped: 0, cappedLabels: [] },
    );
    try {
      assert.match(healthLine(rendered.container)?.textContent ?? "", /Not watching this feed/);
      const header = Array.from(rendered.container.querySelectorAll("h2"))
        .find((heading) => heading.textContent === "Telemetry")
        ?.closest("div");
      assert.ok(header);
      assert.doesNotMatch(header.textContent ?? "", /stopped|polling|poll failing/);
      assert.ok(buttonByText(rendered.container, "Start watching"), "and the control says so too");
    } finally {
      await rendered.unmount();
    }
  });
});

describe("the operator chooses which guards spend feed capacity (issue #310)", () => {
  test("every saved guard is offered a slot, and the one outside the tail is unchecked", async () => {
    const rendered = await renderFeed({ tailSelection: [GUARD_B] });
    try {
      const a = tailCheckbox(rendered.container, "Guard A");
      const b = tailCheckbox(rendered.container, "Guard B");
      const c = tailCheckbox(rendered.container, "Guard C");
      assert.ok(a && b && c, "each registry guard gets a control");

      // The active guard is pinned by rule (#23), so it is shown as such rather
      // than as a choice the operator could lose.
      assert.equal(a.checked, true);
      assert.equal(a.disabled, true);
      assert.match(a.parentElement?.textContent ?? "", /on screen/);
      assert.doesNotMatch(c.parentElement?.textContent ?? "", /on screen/);

      assert.equal(b.checked, true, "a tailed, selected guard reads as checked");
      assert.equal(c.checked, false, "the guard outside the cap reads as unchecked, not missing");
      assert.match(
        textOf(rendered.container, "fieldset legend"),
        /Guards to tail \(2 of 5 slots used\)/,
      );
    } finally {
      await rendered.unmount();
    }
  });

  test("ticking a guard hands the choice to the provider instead of the registry deciding", async () => {
    const chosen: string[] = [];
    const rendered = await renderFeed({ toggleTailedGuard: (guard: string) => chosen.push(guard) });
    try {
      const c = tailCheckbox(rendered.container, "Guard C");
      assert.ok(c);
      await act(async () => {
        c.click();
      });
      assert.deepEqual(chosen, [GUARD_C], "one call, for the guard that was clicked");
    } finally {
      await rendered.unmount();
    }
  });

  test("the cap notice names the untailed guards and points at the chooser", async () => {
    const rendered = await renderFeed();
    try {
      const notices = Array.from(rendered.container.querySelectorAll('[role="status"]')).map(
        (node) => node.textContent ?? "",
      );
      const capped = notices.find((text) => /beyond the 5-guard cap/.test(text));
      assert.ok(capped, "the cap is announced as a status, not as silent truncation");
      assert.match(capped, /Guard C/, "named, not counted");
      assert.match(capped, /Choose which[\s\S]*tail/);
      assert.ok(tailCheckbox(rendered.container, "Guard C"), "and the choice is actually offered");
    } finally {
      await rendered.unmount();
    }
  });

  test("the panel says which guards are live, so the count cannot be read as the registry size", async () => {
    const rendered = await renderFeed();
    try {
      assert.match(
        rendered.container.textContent ?? "",
        /Tailing 2 guards simultaneously, up to the 5-guard cap/,
      );
      assert.match(
        rendered.container.textContent ?? "",
        /remembered for .* only/i,
        "selection is per network, and the panel says so",
      );
    } finally {
      await rendered.unmount();
    }
  });
});

describe("the export is previewed before it is downloaded (issue #309)", () => {
  const scopeNotice = (container: HTMLElement) =>
    Array.from(container.querySelectorAll("div.notice")).find(
      (notice) => notice.querySelector("strong")?.textContent === "Export scope",
    );

  test("the live tail's scope names the range, the count and the diagnostics", async () => {
    const rendered = await renderFeed();
    try {
      const notice = scopeNotice(rendered.container);
      assert.ok(notice, "the panel shows an export preview at all");
      const text = notice.textContent ?? "";
      assert.match(text, /Time range: Live tail — no time bound/);
      assert.match(text, /2 of 2 event\(s\) in scope/);
      assert.match(text, /Diagnostics: included \(1 row\(s\)\)/);
      assert.match(text, /Fields: schema_version,[\s\S]*transaction_hash/);
      assert.match(text, /Not exported: data/, "the payload field is named as omitted");
    } finally {
      await rendered.unmount();
    }
  });

  test("a historical range in force is the range the preview states", async () => {
    const rendered = await renderFeed({
      exportRange: { fromUnixSecs: 100, toUnixSecs: 200 },
      rangeLabel: "Last 24 Hours",
    });
    try {
      const text = scopeNotice(rendered.container)?.textContent ?? "";
      assert.match(text, /Time range: Last 24 Hours/);
      assert.match(text, /0 of 2 event\(s\) in scope/);
      assert.match(text, /2 outside the range excluded/);
    } finally {
      await rendered.unmount();
    }
  });

  test("nothing can be exported from an empty scope, so the number cannot surprise the operator", async () => {
    const rendered = await renderFeed({ exportRange: { fromUnixSecs: 100, toUnixSecs: 200 } });
    try {
      for (const label of ["Export CSV", "Export JSON", "Export NDJSON", "Export audit log"]) {
        const button = buttonByText(rendered.container, label);
        assert.ok(button, `${label} exists`);
        assert.equal(button.disabled, true, `${label} is disabled when the preview has no rows`);
      }
    } finally {
      await rendered.unmount();
    }
  });

  test("the buttons enable exactly when the preview has rows", async () => {
    const rendered = await renderFeed();
    try {
      const button = buttonByText(rendered.container, "Export CSV");
      assert.ok(button);
      assert.equal(button.disabled, false);
      assert.equal(rows(rendered.container).length, 2, "the same rows the preview counted");
    } finally {
      await rendered.unmount();
    }
  });
});

// ── Coverage warnings (#308) ───────────────────────────────────────────────

function feedWith(gaps: unknown[]) {
  return feedState({
    guards: [{ guard: GUARD_A, label: "Guard A" }],
    capped: 0,
    cappedLabels: [],
    gaps,
  });
}

const GAP_NOTICES = (): HTMLElement[] =>
  Array.from(document.querySelectorAll("[data-testid=feed-gap-notice]"));

test("a lost range is announced with its ledger range, and the received rows still show", async () => {
  const rendered = await renderFeed({
    feed: feedWith([
      {
        guard: GUARD_A,
        label: "Guard A",
        lost: [{ reason: "history_pruned", fromLedger: 106, toLedger: 165, detectedAtLedger: 170 }],
        unsettled: null,
      },
    ]),
  });
  try {
    const notices = GAP_NOTICES();
    assert.equal(notices.length, 1);
    const notice = notices[0]!;
    assert.equal(
      notice.getAttribute("role"),
      "alert",
      "lost events interrupt, they do not wait to be found",
    );
    const text = notice.textContent ?? "";
    assert.match(text, /Possible gaps in the feed for Guard A/);
    assert.match(text, /cannot be recovered/);
    assert.match(text, /Ledgers 106–165/);
    assert.match(text, /about 5 minutes/);
    assert.equal(
      rows(rendered.container).length,
      2,
      "the warning does not hide or discard any received row",
    );
  } finally {
    await rendered.unmount();
  }
});

test("an unsettled position says its range is unknown and that it will clear", async () => {
  const rendered = await renderFeed({
    feed: feedWith([
      {
        guard: GUARD_A,
        label: "Guard A",
        lost: [],
        unsettled: {
          reason: "cursor_regressed",
          fromLedger: null,
          toLedger: null,
          detectedAtLedger: 100,
        },
      },
    ]),
  });
  try {
    const notice = GAP_NOTICES()[0]!;
    assert.equal(notice.getAttribute("role"), "status");
    assert.doesNotMatch(notice.className, /danger/);
    const text = notice.textContent ?? "";
    assert.match(text, /range is unknown/);
    assert.match(text, /clears once a later poll is consistent/);
    assert.doesNotMatch(text, /Ledgers \d/, "no range is invented");
  } finally {
    await rendered.unmount();
  }
});

test("each affected guard gets its own notice, and a feed with none shows none", async () => {
  const two = await renderFeed({
    feed: feedWith([
      {
        guard: GUARD_A,
        label: "Guard A",
        lost: [{ reason: "history_pruned", fromLedger: 1, toLedger: 2, detectedAtLedger: 9 }],
        unsettled: null,
      },
      {
        guard: GUARD_B,
        label: "Guard B",
        lost: [{ reason: "history_pruned", fromLedger: 5, toLedger: 8, detectedAtLedger: 9 }],
        unsettled: null,
      },
    ]),
  });
  try {
    const labels = GAP_NOTICES().map((notice) => notice.textContent ?? "");
    assert.equal(labels.length, 2);
    assert.match(labels[0]!, /Guard A/);
    assert.match(labels[1]!, /Guard B/);
  } finally {
    await two.unmount();
  }

  const none = await renderFeed({ feed: feedWith([]) });
  try {
    assert.equal(GAP_NOTICES().length, 0);
  } finally {
    await none.unmount();
  }
});

/*
 * ---------------------------------------------------------------------------
 * Issues #482 and #483 — the operator's bookmark and private note on a row.
 *
 * The store's semantics are unit-tested in `eventMarks.test.ts`; these cases pin
 * what the *screen* does: that the affordance is on the row, that the browser-local
 * wording is visible rather only spoken, that the "Bookmarked only" view narrows the
 * table, and that a refused note keeps its draft where the operator can act on it.
 * ---------------------------------------------------------------------------
 */

/** A value-shaped-as-a-secret note, for the one content the console refuses to store. */
const SECRET_SEED = `S${"A".repeat(55)}`;

function buttonsIn(row: Element): HTMLButtonElement[] {
  return Array.from(row.querySelectorAll<HTMLButtonElement>("button"));
}

function buttonLabeled(container: Element, ...labels: string[]): HTMLButtonElement {
  const wanted = new Set(labels);
  const found = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
    wanted.has(button.textContent?.trim() ?? ""),
  );
  assert.ok(found, `a "${labels[0]}" control must be rendered`);
  return found;
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    (element as HTMLButtonElement).click();
    await sleep(0);
  });
}

/** Type into a controlled field the way a browser does, so React sees the change. */
async function typeInto(textarea: HTMLTextAreaElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  await act(async () => {
    setter?.call(textarea, value);
    textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
    await sleep(0);
  });
}

function marksPanel(container: HTMLElement): Element | null {
  return container.querySelector('[data-testid="marks-panel"]');
}

function indicators(container: HTMLElement): Element[] {
  return Array.from(container.querySelectorAll('[data-testid="mark-indicator"]'));
}

function lastSpoken() {
  return pendingAnnouncements()[pendingAnnouncements().length - 1] ?? null;
}

describe("operator marks on the feed (#482, #483)", () => {
  beforeEach(async () => {
    // The store is a singleton over real `window.localStorage`, so a mark saved by
    // one case would otherwise be on screen in the next.
    eventMarks.resetForTesting();
    window.localStorage.clear();
    clearAnnouncements();
  });

  test("a bookmark marks one row, says whose it is, and persists by event id", async () => {
    const rendered = await renderFeed();
    try {
      const body = rows(rendered.container);
      assert.equal(body.length, 2);
      const first = body[0]!;
      assert.equal(first.getAttribute("data-stream"), "ledger");
      const bookmark = buttonLabeled(first, "Bookmark");
      assert.equal(bookmark.getAttribute("aria-pressed"), "false");
      assert.equal(indicators(rendered.container).length, 0);
      assert.notOk(marksPanel(rendered.container), "no marks, so no panel to explain them");

      await click(bookmark);

      const row = rows(rendered.container)[0]!;
      assert.equal(buttonLabeled(row, "Bookmarked").getAttribute("aria-pressed"), "true");
      assert.equal(
        buttonLabeled(rows(rendered.container)[1]!, "Bookmark").getAttribute("aria-pressed"),
        "false",
        "the sibling row is untouched",
      );

      // The visible indicator is the point: #483's failure mode is a note being read
      // back as something the guard or the agent said.
      const indicator = indicators(rendered.container)[0]!;
      assert.dom(indicator).containsText("browser-local");
      assert.dom(indicator).containsText("bookmarked");

      const panel = marksPanel(rendered.container);
      assert.ok(panel, "a saved mark earns its own explanation");
      assert.dom(panel).containsText("1 operator mark saved in this browser");

      const spoken = lastSpoken();
      assert.equal(spoken?.message, "Bookmarked in this browser");
      assert.equal(spoken?.priority, "polite");
      const stored = window.localStorage.getItem(eventMarks.storageKeyFor(GUARD_A));
      assert.ok(stored !== null, "the mark is in this browser's storage");
      assert.match(stored!, /"bookmarked":true/);
    } finally {
      await rendered.unmount();
    }
  });

  test("un-marking takes the row, the panel and the wording back", async () => {
    const rendered = await renderFeed();
    try {
      const bookmark = buttonLabeled(rows(rendered.container)[0]!, "Bookmark");
      await click(bookmark);
      assert.equal(indicators(rendered.container).length, 1);

      await click(buttonLabeled(rows(rendered.container)[0]!, "Bookmarked"));

      assert.equal(indicators(rendered.container).length, 0);
      assert.notOk(marksPanel(rendered.container), "the panel goes with the last mark");
      assert.equal(window.localStorage.getItem(eventMarks.storageKeyFor(GUARD_A)), null);
      assert.equal(lastSpoken()?.message, "Bookmark removed");
    } finally {
      await rendered.unmount();
    }
  });

  test("a bookmarked diagnostic says there is no ledger to re-read it from", async () => {
    const rendered = await renderFeed();
    try {
      // Row two is the refusal: `diag:`-hashed identity, no transaction behind it.
      const refusal = rows(rendered.container)[1]!;
      assert.equal(refusal.getAttribute("data-stream"), "diagnostic");
      await click(buttonLabeled(refusal, "Bookmark"));

      assert.equal(
        lastSpoken()?.message,
        "Bookmarked in this browser; this row has no ledger to re-read it from",
      );
      assert.equal(
        window.localStorage.getItem(eventMarks.storageKeyFor(GUARD_B)) !== null,
        true,
        "the mark is scoped to the guard that emitted the refusal",
      );
    } finally {
      await rendered.unmount();
    }
  });

  test("a row the feed cannot identify offers no control and says why", async () => {
    const unaddressable = { ...event(GUARD_A, 300, false), contractId: null };
    const rendered = await renderFeed({}, {}, [unaddressable]);
    try {
      const row = rows(rendered.container)[0]!;
      assert.equal(
        buttonsIn(row).some((button) => /Bookmark|^Note$/.test(button.textContent ?? "")),
        false,
      );
      const notice = row.querySelector('[data-testid="mark-unavailable"]');
      assert.ok(notice, "the reason is on screen, not only in the announcement queue");
      assert.dom(notice).containsText("nothing to save a mark against");
      assert.equal(
        window.localStorage.getItem(eventMarks.storageKeyFor(GUARD_A)),
        null,
        "and no mark was written for a row that cannot be identified",
      );
    } finally {
      await rendered.unmount();
    }
  });

  test("a note saves against the row's identity and reads back on the row", async () => {
    const rendered = await renderFeed();
    try {
      const row = rows(rendered.container)[0]!;
      await click(buttonLabeled(row, "Note"));
      const textarea = rendered.container.querySelector("textarea");
      assert.ok(textarea, "the editor opens in the row");
      assert.match(
        textarea.getAttribute("aria-label") ?? "",
        /stored in this browser only/,
        "the field itself says where the text will live",
      );
      assert.dom(textarea.parentElement!).containsText(`0/${EVENT_NOTE_MAX_LENGTH} characters`);

      const noteText = "correlate with the 12:00 deploy";
      await typeInto(textarea, noteText);
      assert
        .dom(textarea.parentElement!)
        .containsText(`${noteText.length}/${EVENT_NOTE_MAX_LENGTH} characters`);
      await click(buttonLabeled(rendered.container, "Save note"));

      const marked = rows(rendered.container)[0]!;
      assert.notOk(marked.querySelector("textarea"), "saving closes the editor");
      assert.dom(indicators(marked)[0]!).containsText(noteText);
      assert.equal(lastSpoken()?.message, "Note saved in this browser");
      assert.equal(buttonLabeled(marked, "Edit note").textContent?.trim(), "Edit note");
    } finally {
      await rendered.unmount();
    }
  });

  test("a note holding a secret key is refused inline, with the draft kept", async () => {
    const rendered = await renderFeed();
    try {
      const row = rows(rendered.container)[0]!;
      await click(buttonLabeled(row, "Note"));
      const textarea = rendered.container.querySelector("textarea")!;
      await typeInto(textarea, `key: ${SECRET_SEED}`);
      await click(buttonLabeled(rendered.container, "Save note"));

      const error = rendered.container.querySelector('[data-testid="note-error"]');
      assert.ok(error, "the refusal is stated on the row");
      assert.equal(error.getAttribute("role"), "alert");
      assert.dom(error).containsText("secret key");
      // A boolean rather than `doesNotContainText`: that helper quotes the needle in
      // its failure message, and the needle here is the key-shaped string.
      assert.ok(
        !(error.textContent ?? "").includes(SECRET_SEED),
        "the refusal names the problem without echoing the text back",
      );
      assert.equal(
        rendered.container.querySelector("textarea")?.value,
        `key: ${SECRET_SEED}`,
        "the editor stays open so the operator can fix the text rather than lose it",
      );
      assert.equal(indicators(rendered.container).length, 0);
      assert.equal(window.localStorage.getItem(eventMarks.storageKeyFor(GUARD_A)), null);
      assert.equal(lastSpoken()?.priority, "assertive");
      assert.match(lastSpoken()?.message ?? "", /^Note was not saved: /);
    } finally {
      await rendered.unmount();
    }
  });

  test("cancelling a note writes nothing, and an empty save on a bare row stays silent", async () => {
    const rendered = await renderFeed();
    try {
      const row = rows(rendered.container)[0]!;
      await click(buttonLabeled(row, "Note"));
      await typeInto(rendered.container.querySelector("textarea")!, "abandoned thought");
      await click(buttonLabeled(rendered.container, "Cancel"));

      assert.notOk(rendered.container.querySelector("textarea"), "cancel closes the editor");
      assert.equal(indicators(rendered.container).length, 0);
      assert.equal(window.localStorage.getItem(eventMarks.storageKeyFor(GUARD_A)), null);

      // An empty note on a row that holds nothing removes nothing, so the console
      // says nothing rather than announcing a removal that did not happen.
      await click(buttonLabeled(rows(rendered.container)[0]!, "Note"));
      await click(buttonLabeled(rendered.container, "Save note"));
      assert.deepEqual(pendingAnnouncements(), []);
      assert.equal(lastSpoken(), null);
    } finally {
      await rendered.unmount();
    }
  });

  test("the bookmarked-only view narrows the table to what the operator saved", async () => {
    const rendered = await renderFeed();
    try {
      await click(buttonLabeled(rows(rendered.container)[0]!, "Bookmark"));
      const panel = marksPanel(rendered.container);
      assert.ok(panel);
      assert.dom(panel).containsText("(1 in view)");
      const checkbox = panel.querySelector('input[type="checkbox"]') as HTMLInputElement;
      assert.ok(checkbox);

      await click(checkbox);
      const shown = rows(rendered.container);
      assert.equal(shown.length, 1, "only the bookmarked row is in view");
      assert.equal(shown[0]?.getAttribute("data-stream"), "ledger");
      assert.equal(checkbox.checked, true);
      assert.equal(indicators(rendered.container).length, 1);

      // Both rows bookmarked: the view holds both, and the count moved with them.
      await click(checkbox);
      await click(buttonLabeled(rows(rendered.container)[1]!, "Bookmark"));
      await click(checkbox);
      assert.equal(rows(rendered.container).length, 2);
      assert.dom(marksPanel(rendered.container)).containsText("2 operator marks saved");
    } finally {
      await rendered.unmount();
    }
  });

  test("clearing the filters clears the bookmark view too", async () => {
    const rendered = await renderFeed();
    try {
      await click(buttonLabeled(rows(rendered.container)[0]!, "Bookmark"));
      const checkbox = marksPanel(rendered.container)!.querySelector('input[type="checkbox"]')!;
      await click(checkbox);
      assert.equal(rows(rendered.container).length, 1);

      await click(buttonLabeled(rendered.container, "Clear filters"));

      assert.equal(rows(rendered.container).length, 2);
      assert.equal(
        (
          marksPanel(rendered.container)!.querySelector(
            'input[type="checkbox"]',
          ) as HTMLInputElement
        ).checked,
        false,
        "the bookmark view is a filter, so clearing filters clears it",
      );
      assert.equal(
        indicators(rendered.container).length,
        1,
        "clearing the view never deletes the mark",
      );
    } finally {
      await rendered.unmount();
    }
  });

  test("a mark adds no live region of its own to the feed", async () => {
    const rendered = await renderFeed();
    try {
      // The chart ships its own keyboard readout, so the claim is about what marking
      // a row *adds* — a new live region would interrupt the operator mid-sentence
      // and duplicate what the announcer already says.
      const liveBefore = Array.from(rendered.container.querySelectorAll("[aria-live]"));
      await click(buttonLabeled(rows(rendered.container)[0]!, "Bookmark"));
      const liveAfter = Array.from(rendered.container.querySelectorAll("[aria-live]"));

      assert.equal(liveAfter.length, liveBefore.length, "marking a row added no live region");
      // A boolean, not the node: `assert.equal(element, null)` on a failure asks
      // Node to inspect a jsdom subtree and the report never comes back.
      assert.ok(
        liveAfter.every(
          (region) =>
            region.closest('[data-testid="marks-panel"], [data-testid="mark-indicator"]') === null,
        ),
        "and none of the regions on screen belongs to the mark UI",
      );
      assert.equal(
        pendingAnnouncements().length,
        1,
        "the operator's words left through the announce queue, the only channel",
      );
    } finally {
      await rendered.unmount();
    }
  });
});

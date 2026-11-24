import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import type { ReactElement } from "react";
import { Contract, rpc, xdr } from "@stellar/stellar-sdk";
import { installDom, loadReact, sleep, type Act } from "./domHarness.ts";
import {
  EVENT_DETAIL_PAGE_LIMIT,
  EVENT_LINK_EVENT,
  eventLinkTargetFor,
  writeEventLink,
} from "../../lib/guard/eventLink.ts";
import { NETWORK } from "../../lib/guard/network.ts";
import { POLL_OFF } from "../../lib/guard/feedHealth.ts";
import { EventDetailPanel } from "../../components/EventDetailPanel.tsx";
import { TelemetryFeed } from "../../components/TelemetryFeed.tsx";
import { GuardContext, GuardEventsContext } from "../../components/GuardProvider.tsx";
import { withIdentity } from "../mocks/eventFixtures.ts";
import type { GuardEvent } from "stellar-agent-guard-sdk";

/**
 * The focused event view, end to end in the DOM (issue #485).
 *
 * The codec has its own suite; this one covers what only a browser can answer —
 * that focusing a row rewrites the address bar without navigating, that closing
 * gives the arrived URL back, that the panel's answer comes from a chain read
 * rather than the feed buffer, and that a refusal row offers no link at all.
 */

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

const GUARD = "CAYJZT4XH5SWDXNR7MZJCCUBIDAT2KZDDUTZ7OZQEMKCPJGD4P3X4CU7";
const OTHER = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const HEARTBEAT = "event_heartbeat";
const LEDGER = 51;
const HASH = LEDGER.toString(16).padStart(64, "0");
const LOCATOR = `${LEDGER}:${HASH}:${HEARTBEAT}`;

const cursorAt = (ledger: number) => `${String(ledger).padStart(19, "0")}-0000000000`;

/** An RPC that serves `LEDGER`'s heartbeat and records how often it was asked. */
function chainServer(options: { fails?: boolean } = {}) {
  const calls: Array<Record<string, unknown>> = [];
  const server = {
    getLatestLedger: async () => ({ sequence: 900, closeTime: "1770000000" }),
    getEvents: async (request: Record<string, unknown>) => {
      calls.push(request);
      if (options.fails) throw new Error("rpc unreachable");
      return {
        events: [
          {
            id: cursorAt(LEDGER),
            type: "contract",
            ledger: LEDGER,
            ledgerClosedAt: "2026-11-20T00:00:00Z",
            transactionIndex: 1,
            operationIndex: 0,
            inSuccessfulContractCall: true,
            txHash: HASH,
            contractId: new Contract(GUARD),
            topic: [xdr.ScVal.scvSymbol(HEARTBEAT)],
            value: xdr.ScVal.scvMap([
              new xdr.ScMapEntry({
                key: xdr.ScVal.scvSymbol("at"),
                val: xdr.ScVal.scvU64(BigInt(LEDGER)),
              }),
            ]),
          } as rpc.Api.EventResponse,
        ],
        cursor: cursorAt(LEDGER),
        latestLedger: 900,
        oldestLedger: 10,
      };
    },
  } as unknown as rpc.Server;
  return { server, calls };
}

function committed(): GuardEvent {
  return withIdentity({
    kind: "heartbeat",
    topic: HEARTBEAT,
    source: "ledger",
    contractId: GUARD,
    ledger: LEDGER,
    ledgerClosedAt: "2026-11-20T00:00:00Z",
    transactionHash: HASH,
    decision: null,
    data: { at: BigInt(LEDGER) },
  });
}

function refusal(): GuardEvent {
  return withIdentity({
    kind: "auth_checked",
    topic: "event_auth_checked",
    source: "diagnostic",
    contractId: GUARD,
    ledger: null,
    ledgerClosedAt: null,
    transactionHash: null,
    decision: { result: "blocked", reason: "per_tx_cap_exceeded", source: "diagnostic" },
    data: {},
  });
}

/** Put the browser at a known URL before a test renders against it. */
function at(search: string): void {
  window.history.replaceState({}, "", search === "" ? "/" : `/${search}`);
}

async function render(element: ReactElement, server: rpc.Server) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: ReturnType<typeof createRoot> | undefined;
  await act(async () => {
    root = createRoot(container);
    root.render(
      react.createElement(
        GuardContext.Provider,
        {
          value: {
            server,
            instances: [
              { guard: GUARD, label: "Primary" },
              { guard: OTHER, label: "Sister" },
            ],
            guard: GUARD,
            feed: { watching: false, guards: [GUARD], gaps: [], health: null },
          } as never,
        },
        element,
      ),
    );
  });
  await act(async () => {
    await sleep(40);
  });
  return {
    container,
    text: () => container.textContent ?? "",
    unmount: async () => {
      await act(async () => {
        root?.unmount();
      });
      container.remove();
    },
  };
}

/** The button on a row that focuses it, if the row rendered one. */
function permalinkLinks(container: HTMLElement): HTMLAnchorElement[] {
  return Array.from(
    container.querySelectorAll<HTMLAnchorElement>("a[data-testid=event-permalink]"),
  );
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(
      new window.MouseEvent("click", { bubbles: true, cancelable: true, view: window }),
    );
    await sleep(40);
  });
}

describe("writeEventLink", () => {
  test("focuses a row by rewriting the address bar, not by navigating", async () => {
    at(`?guard=${GUARD}&tab=telemetry&filter=blocked`);
    const before = window.location.href;
    let announced = 0;
    const listen = () => {
      announced += 1;
    };
    window.addEventListener(EVENT_LINK_EVENT, listen);
    try {
      await act(async () => {
        writeEventLink(LOCATOR);
      });
    } finally {
      window.removeEventListener(EVENT_LINK_EVENT, listen);
    }
    const params = new URLSearchParams(window.location.search);
    assert.equal(params.get("event"), LOCATOR, "the locator is now in the URL");
    assert.equal(params.get("guard"), GUARD, "the view state the operator arrived with survives");
    assert.equal(params.get("tab"), "telemetry");
    assert.equal(params.get("filter"), "blocked");
    assert.ok(announced > 0, "replaceState fires no popstate, so the write must announce itself");
    assert.equal(
      window.location.pathname,
      new URL(before).pathname,
      "focusing a row stays on the page the operator was reading",
    );
  });

  test("closing gives back the URL the operator arrived with", async () => {
    at(`?guard=${GUARD}&tab=telemetry`);
    await act(async () => {
      writeEventLink(LOCATOR);
    });
    assert.ok(window.location.search.includes("event="));
    await act(async () => {
      writeEventLink(null);
    });
    assert.equal(window.location.search, `?guard=${GUARD}&tab=telemetry`);
  });

  test("is a no-op when nothing would change", async () => {
    at(`?event=${encodeURIComponent(LOCATOR)}`);
    let announced = 0;
    const listen = () => {
      announced += 1;
    };
    window.addEventListener(EVENT_LINK_EVENT, listen);
    try {
      await act(async () => {
        writeEventLink(LOCATOR);
      });
    } finally {
      window.removeEventListener(EVENT_LINK_EVENT, listen);
    }
    assert.equal(announced, 0, "a redundant write must not re-read the chain");
  });
});

describe("EventDetailPanel", () => {
  test("renders nothing at all when the URL carries no event parameter", async () => {
    at(`?guard=${GUARD}`);
    const { server, calls } = chainServer();
    const rendered = await render(react.createElement(EventDetailPanel), server);
    try {
      assert.equal(rendered.container.querySelector('[data-testid="event-detail"]'), null);
      assert.deepEqual(calls, [], "and it asks the chain for nothing");
    } finally {
      await rendered.unmount();
    }
  });

  test("answers a focused link from the chain, not the buffer", async () => {
    at(`?network=${NETWORK.name}&guard=${GUARD}&event=${LOCATOR}`);
    const { server, calls } = chainServer();
    const rendered = await render(react.createElement(EventDetailPanel), server);
    try {
      const text = rendered.text();
      assert.match(text, /Event detail/);
      assert.match(text, /Re-read from the chain just now/);
      assert.equal(
        calls.length,
        1,
        `one bounded lookup, not a page per render (got ${JSON.stringify(calls)})`,
      );
      assert.equal(calls[0]?.startLedger, LEDGER);
      assert.ok(
        (calls[0]?.limit as number) <= EVENT_DETAIL_PAGE_LIMIT,
        "the read is bounded to a page size the console already uses elsewhere",
      );
    } finally {
      await rendered.unmount();
    }
  });

  test("says which way an unavailable event failed", async () => {
    at(`?guard=${GUARD}&event=${LOCATOR}`);
    const { server } = chainServer({ fails: true });
    const rendered = await render(react.createElement(EventDetailPanel), server);
    try {
      assert.match(rendered.text(), /This event is unavailable/);
      assert.match(rendered.text(), /re-read did not complete/);
      assert.match(rendered.text(), /nothing about the event/);
    } finally {
      await rendered.unmount();
    }
  });

  test("a diagnostic link is answered with zero RPC calls", async () => {
    at(`?guard=${GUARD}&event=diag:${"a".repeat(64)}`);
    const { server, calls } = chainServer();
    const rendered = await render(react.createElement(EventDetailPanel), server);
    try {
      assert.match(rendered.text(), /names a refused decision/);
      assert.deepEqual(calls, [], "a rolled-back call has no ledger record to ask about");
    } finally {
      await rendered.unmount();
    }
  });

  test("a malformed link blames a parameter instead of rendering a blank box", async () => {
    at(`?guard=${GUARD}&event=51:deadbeef:${HEARTBEAT}`);
    const { server, calls } = chainServer();
    const rendered = await render(react.createElement(EventDetailPanel), server);
    try {
      assert.match(rendered.text(), /event link is not usable/);
      assert.match(rendered.text(), /event parameter was rejected/);
      assert.match(rendered.text(), /not 64 hex/);
      assert.deepEqual(calls, [], "nothing invalid reaches the chain read");
    } finally {
      await rendered.unmount();
    }
  });

  test("a link naming another network is rejected rather than answered here", async () => {
    at(`?network=mainnet&guard=${GUARD}&event=${LOCATOR}`);
    const { server, calls } = chainServer();
    const rendered = await render(react.createElement(EventDetailPanel), server);
    try {
      assert.match(rendered.text(), /network parameter was rejected/);
      assert.deepEqual(calls, []);
    } finally {
      await rendered.unmount();
    }
  });

  test("close clears the parameter and the panel", async () => {
    at(`?guard=${GUARD}&event=${LOCATOR}`);
    const { server } = chainServer();
    const rendered = await render(react.createElement(EventDetailPanel), server);
    try {
      const close = Array.from(rendered.container.querySelectorAll("button")).find(
        (button) => button.textContent === "Close",
      );
      assert.ok(close, "the panel offers a way out");
      await click(close!);
      assert.equal(window.location.search, `?guard=${GUARD}`);
      assert.equal(rendered.container.querySelector('[data-testid="event-detail"]'), null);
    } finally {
      await rendered.unmount();
    }
  });
});

describe("the feed's row affordance", () => {
  async function renderFeed(events: GuardEvent[]) {
    const { server, calls } = chainServer();
    const container = document.createElement("div");
    document.body.appendChild(container);
    let root: ReturnType<typeof createRoot> | undefined;
    await act(async () => {
      root = createRoot(container);
      root.render(
        react.createElement(
          GuardContext.Provider,
          {
            value: {
              server,
              instances: [{ guard: GUARD, label: "Primary" }],
              guard: GUARD,
              feed: {
                watching: true,
                latestLedger: 900,
                error: null,
                lastPolledAt: null,
                guards: [{ guard: GUARD, label: "Primary" }],
                capped: 0,
                cappedLabels: [],
                gaps: [],
                health: POLL_OFF,
              },
              stream: { paused: false, pendingCount: 0, dropped: 0 },
              pauseStream: () => {},
              resumeStream: () => {},
              clearEvents: () => {},
              pushEvents: () => {},
              notifyTabs: () => {},
              queryRange: async () => {},
              backToLive: () => {},
              rangeLabel: null,
              exportRange: null,
              tailSelection: [],
              toggleTailedGuard: () => {},
              startWatching: () => {},
              stopWatching: () => {},
              selectGuard: () => {},
              addInstance: () => {},
            } as never,
          },
          react.createElement(
            GuardEventsContext.Provider,
            { value: events },
            react.createElement(TelemetryFeed),
          ),
        ),
      );
    });
    await act(async () => {
      await sleep(40);
    });
    return {
      container,
      calls,
      unmount: async () => {
        await act(async () => {
          root?.unmount();
        });
        container.remove();
      },
    };
  }

  test("a committed row links to itself and focusing it opens the detail", async () => {
    at(`?guard=${GUARD}`);
    const rendered = await renderFeed([committed()]);
    try {
      const links = permalinkLinks(rendered.container);
      assert.equal(links.length, 1);
      assert.ok(links[0]!.getAttribute("href")?.includes(`event=${encodeURIComponent(LOCATOR)}`));
      await click(links[0]!);
      assert.ok(window.location.search.includes("event="), "clicking focuses the row in place");
      assert.ok(
        rendered.container.querySelector('[data-testid="event-detail"]'),
        "and the detail opens in the same document",
      );
    } finally {
      await rendered.unmount();
    }
  });

  test("a refusal row renders no link, because it has no ledger record", async () => {
    at(`?guard=${GUARD}`);
    const rendered = await renderFeed([refusal()]);
    try {
      assert.deepEqual(permalinkLinks(rendered.container), []);
      assert.equal(eventLinkTargetFor(refusal()), null);
    } finally {
      await rendered.unmount();
    }
  });

  test("a row from a second tailed guard links to that guard", async () => {
    const borrowed = withIdentity({ ...committed(), contractId: OTHER });
    const target = eventLinkTargetFor(borrowed);
    assert.equal(target?.guard, OTHER, "the link asks the contract that emitted the row");
    assert.equal(target?.raw, LOCATOR, "and the row's own locator is unchanged by attribution");
  });
});

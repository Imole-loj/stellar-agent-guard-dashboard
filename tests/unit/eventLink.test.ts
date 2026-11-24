import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Contract, rpc, xdr } from "@stellar/stellar-sdk";
import { GUARD_EVENT_TOPICS } from "stellar-agent-guard-sdk";
import {
  EVENT_DETAIL_MAX_PAGES,
  decodeEventLink,
  eventHref,
  eventLinkQuery,
  eventLinkTargetFor,
  eventLocatorFor,
  loadEventDetail,
  mergeEventParam,
  parseEventLocator,
} from "../../lib/guard/eventLink.ts";
import type { TelemetryEvent } from "../../lib/guard/telemetry.ts";
import { NETWORK } from "../../lib/guard/network.ts";

/**
 * Focused event permalinks (issue #485).
 *
 * The rules under test are the three the issue states as acceptance criteria —
 * encode only network + guard + locator, validate every parameter, and re-read the
 * chain and say which way the read failed when it cannot be answered — plus the
 * corollary that a link must never disturb the live feed it was opened from.
 */

const GUARD = "CAYJZT4XH5SWDXNR7MZJCCUBIDAT2KZDDUTZ7OZQEMKCPJGD4P3X4CU7";
const HEARTBEAT = GUARD_EVENT_TOPICS.heartbeat;
const AUTH_CHECKED = GUARD_EVENT_TOPICS.authChecked;

/** A 64-hex transaction hash derived from the ledger, so each row has its own. */
const hashAt = (ledger: number) => ledger.toString(16).padStart(64, "0");

const LOCATOR = `51:${hashAt(51)}:${HEARTBEAT}`;

/** A stellar-rpc style event id: a 19-digit TOID, a dash and a 10-digit index. */
const cursorAt = (ledger: number, index = 0) =>
  `${String(ledger).padStart(19, "0")}-${String(index).padStart(10, "0")}`;

interface StubEvent {
  ledger: number;
  hash?: string;
  topic?: string;
}

interface StubPage {
  events?: StubEvent[];
  latestLedger: number;
  oldestLedger?: number | null;
  cursor?: string;
}

/**
 * A stub RPC serving one scripted page per `getEvents` call, recording each request.
 *
 * The recording is load-bearing: several of these tests assert not only the answer
 * but that the lookup asked for the locator's own ledger (so it is bounded) and, for
 * a refusal, that it asked for nothing at all.
 */
function scriptedServer(pages: StubPage[]) {
  const requests: Array<{ startLedger?: number; cursor?: string; limit?: number }> = [];
  let call = 0;
  const server = {
    getLatestLedger: async () => ({ sequence: 100, closeTime: "1770000000" }),
    getEvents: async (request: { startLedger?: number; cursor?: string; limit?: number }) => {
      requests.push(request);
      const page = pages[Math.min(call, pages.length - 1)]!;
      call += 1;
      const events = (page.events ?? []).map(
        (event) =>
          ({
            id: cursorAt(event.ledger),
            type: "contract",
            ledger: event.ledger,
            ledgerClosedAt: "2026-11-20T00:00:00Z",
            transactionIndex: 1,
            operationIndex: 0,
            inSuccessfulContractCall: true,
            txHash: event.hash ?? hashAt(event.ledger),
            contractId: new Contract(GUARD),
            topic: [xdr.ScVal.scvSymbol(event.topic ?? HEARTBEAT)],
            value: xdr.ScVal.scvMap([
              new xdr.ScMapEntry({
                key: xdr.ScVal.scvSymbol("at"),
                val: xdr.ScVal.scvU64(BigInt(event.ledger)),
              }),
            ]),
          }) as rpc.Api.EventResponse,
      );
      return {
        events,
        cursor: page.cursor ?? cursorAt(page.latestLedger),
        latestLedger: page.latestLedger,
        ...(page.oldestLedger === undefined ? {} : { oldestLedger: page.oldestLedger }),
      };
    },
  } as unknown as rpc.Server;
  return { server, requests };
}

/** A committed row, as the feed holds it. */
function row(overrides: Partial<TelemetryEvent> = {}): TelemetryEvent {
  return {
    id: `ledger:${hashAt(51)}:${HEARTBEAT}`,
    kind: "heartbeat",
    topic: HEARTBEAT,
    source: "ledger",
    contractId: GUARD,
    ledger: 51,
    ledgerClosedAt: "2026-11-20T00:00:00Z",
    observedAt: null,
    transactionHash: hashAt(51),
    decision: null,
    data: { at: 51n },
    ...overrides,
  } as TelemetryEvent;
}

describe("parseEventLocator", () => {
  test("accepts the canonical shape and normalises case", () => {
    const upper = `51:${hashAt(51).toUpperCase()}:${HEARTBEAT}`;
    const parsed = parseEventLocator(upper);
    assert.equal(parsed.status, "valid");
    assert.deepEqual(
      parsed.status === "valid" ? parsed.locator : null,
      { kind: "ledger", ledger: 51, transactionHash: hashAt(51), topic: HEARTBEAT },
      "the hash is lower-cased so a chain read compares with plain equality",
    );
  });

  test("recognises the SDK's diagnostic id rather than calling it malformed", () => {
    const parsed = parseEventLocator(`diag:${"a".repeat(64)}`);
    assert.deepEqual(parsed, {
      status: "valid",
      locator: { kind: "diagnostic", digest: "a".repeat(64) },
    });
  });

  test("treats an empty or missing value as absent, not invalid", () => {
    for (const value of [null, undefined, "", "   "]) {
      assert.deepEqual(parseEventLocator(value), { status: "absent" }, JSON.stringify(value));
    }
  });

  test("rejects every malformed shape with a reason", () => {
    const cases: Array<[string, RegExp]> = [
      ["", /absent/],
      [`51:${hashAt(51)}`, /2 parts/],
      [`51:${hashAt(51)}:${HEARTBEAT}:extra`, /4 parts/],
      [`0:${hashAt(51)}:${HEARTBEAT}`, /not a positive integer/],
      [`-5:${hashAt(51)}:${HEARTBEAT}`, /not a positive integer/],
      [`05:${hashAt(51)}:${HEARTBEAT}`, /not a positive integer/],
      [`5.5:${hashAt(51)}:${HEARTBEAT}`, /not a positive integer/],
      [`51:deadbeef:${HEARTBEAT}`, /not 64 hex/],
      [`51:${"z".repeat(64)}:${HEARTBEAT}`, /not 64 hex/],
      [`51:${hashAt(51)}:event_not_a_real_topic`, /unknown guard event topic/],
      [`diag:${"a".repeat(63)}`, /diagnostic locator digest is not 64 hex/],
      [`99:${hashAt(51)}:${HEARTBEAT}${"!".repeat(200)}`, /too long/],
    ];
    for (const [raw, expected] of cases) {
      const parsed = parseEventLocator(raw);
      if (raw.trim() === "") {
        assert.equal(parsed.status, "absent", raw);
        continue;
      }
      assert.equal(parsed.status, "malformed", raw);
      assert.match(
        parsed.status === "malformed" ? parsed.reason : "",
        expected,
        `${raw} should explain itself`,
      );
    }
  });

  test("bounds the ledger before Number runs, so a 40-digit string cannot be a locator", () => {
    assert.equal(
      parseEventLocator(`${"9".repeat(40)}:${hashAt(51)}:${HEARTBEAT}`).status,
      "malformed",
    );
  });
});

describe("eventLocatorFor", () => {
  test("mints a locator for a committed row", () => {
    assert.equal(eventLocatorFor(row()), LOCATOR);
  });

  test("refuses a diagnostic row: a refusal has no ledger record to link to", () => {
    const refusal = row({ source: "diagnostic", ledger: null, transactionHash: null });
    assert.equal(eventLocatorFor(refusal), null);
  });

  test("refuses a row the console cannot address", () => {
    const missing = [
      row({ ledger: null }),
      row({ ledger: 0 }),
      row({ transactionHash: null }),
      row({ transactionHash: "tx-51" }),
      row({ topic: "event_something_else" }),
    ];
    for (const event of missing) {
      assert.equal(eventLocatorFor(event), null, JSON.stringify(event.ledger));
    }
  });
});

describe("eventLinkTargetFor", () => {
  test("takes the guard from the row's own contract, not the console's selection", () => {
    const other = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    assert.deepEqual(eventLinkTargetFor(row({ contractId: other })), {
      guard: other,
      raw: LOCATOR,
    });
  });

  test("refuses a row with no contract or one that is not an address", () => {
    assert.equal(eventLinkTargetFor(row({ contractId: null })), null);
    assert.equal(eventLinkTargetFor(row({ contractId: "not-an-address" })), null);
  });
});

describe("eventLinkQuery and eventHref", () => {
  test("encode exactly three parameters, in canonical order", () => {
    const query = eventLinkQuery(GUARD, LOCATOR)!;
    assert.deepEqual(
      [...new URLSearchParams(query).keys()],
      ["network", "guard", "event"],
      "a link carries an address, never a payload — no decision, amount or key material",
    );
    assert.equal(new URLSearchParams(query).get("network"), NETWORK.name);
    assert.equal(new URLSearchParams(query).get("event"), LOCATOR);
  });

  test("carries nothing that could be mistaken for a secret", () => {
    const query = eventLinkQuery(GUARD, LOCATOR)!;
    for (const forbidden of ["secret", "seed", "S", "xdr", "signature", "payload"]) {
      assert.ok(
        !new URLSearchParams(query).has(forbidden),
        `a permalink must never carry ${forbidden}`,
      );
    }
    assert.ok(!/S[A-Z0-9]{55}/.test(query), "no strkey secret seed can appear in the link");
  });

  test("refuses to mint a link from inputs the console would reject", () => {
    assert.equal(eventLinkQuery("not-an-address", LOCATOR), null);
    assert.equal(eventLinkQuery(GUARD, "51:deadbeef:event_heartbeat"), null);
    assert.equal(eventHref(GUARD, "nonsense"), null);
  });

  test("eventHref is a relative URL, so a preview deployment links to itself", () => {
    const href = eventHref(GUARD, LOCATOR)!;
    assert.ok(href.startsWith("/?"), `expected a root-relative URL, got ${href}`);
    assert.ok(!/^https?:/.test(href) && !href.includes("localhost"), "no origin is baked in");
  });
});

describe("decodeEventLink", () => {
  test("reads a well-formed link", () => {
    const link = decodeEventLink(`?network=${NETWORK.name}&guard=${GUARD}&event=${LOCATOR}`);
    assert.deepEqual(link, {
      status: "ready",
      guard: GUARD,
      locator: {
        kind: "ledger",
        ledger: 51,
        transactionHash: hashAt(51),
        topic: HEARTBEAT,
      },
      raw: LOCATOR,
    });
  });

  test("an ordinary console URL is absent, not invalid", () => {
    assert.deepEqual(decodeEventLink("?guard=CAI&tab=telemetry"), { status: "absent" });
    assert.deepEqual(decodeEventLink(""), { status: "absent" });
    assert.deepEqual(decodeEventLink("?event="), { status: "absent" });
  });

  test("names the parameter that failed so the panel can say so", () => {
    const cases: Array<[string, "guard" | "network" | "event"]> = [
      ["?event=nonsense", "guard"],
      [`?guard=${GUARD}&event=51:deadbeef:${HEARTBEAT}`, "event"],
      [`?network=mainnet&guard=${GUARD}&event=${LOCATOR}`, "network"],
      [`?guard=not-an-address&event=${LOCATOR}`, "guard"],
    ];
    for (const [search, parameter] of cases) {
      const link = decodeEventLink(search);
      assert.equal(link.status, "invalid", search);
      assert.equal(
        link.status === "invalid" ? link.parameter : null,
        parameter,
        `${search} should blame ${parameter}`,
      );
      assert.ok(
        (link.status === "invalid" ? link.reason : "").length > 10,
        `${search} should explain itself, not just point`,
      );
    }
  });

  test("a duplicated event parameter is ambiguous, so it is rejected", () => {
    const link = decodeEventLink(
      `?guard=${GUARD}&event=${LOCATOR}&event=52:${hashAt(52)}:${HEARTBEAT}`,
    );
    assert.equal(link.status, "invalid");
    assert.equal(link.status === "invalid" ? link.parameter : null, "event");
  });

  test("a network parameter matching this build is accepted in any case", () => {
    const link = decodeEventLink(
      `?network=${NETWORK.name.toUpperCase()}&guard=${GUARD}&event=${LOCATOR}`,
    );
    assert.equal(link.status, "ready");
  });
});

describe("mergeEventParam", () => {
  test("adds the locator and leaves every other parameter alone, in order", () => {
    const merged = mergeEventParam(`guard=${GUARD}&tab=telemetry&filter=blocked`, LOCATOR);
    assert.deepEqual(
      [...new URLSearchParams(merged).keys()],
      ["guard", "tab", "filter", "event"],
      "the locator lands last, so a shared view URL keeps its own parameters and their order",
    );
    assert.equal(new URLSearchParams(merged).get("guard"), GUARD);
    assert.equal(new URLSearchParams(merged).get("event"), LOCATOR);
  });

  test("deleting the locator gives back the URL the operator arrived with", () => {
    const search = `guard=${GUARD}&tab=telemetry&event=${LOCATOR}`;
    assert.equal(mergeEventParam(search, null), `guard=${GUARD}&tab=telemetry`);
  });

  test("replaces rather than appends, so a link swap is unambiguous", () => {
    const merged = mergeEventParam(`event=${LOCATOR}`, `52:${hashAt(52)}:${HEARTBEAT}`);
    assert.equal(new URLSearchParams(merged).getAll("event").length, 1);
    assert.equal(new URLSearchParams(merged).get("event"), `52:${hashAt(52)}:${HEARTBEAT}`);
  });

  test("survives a round trip with the view state on both sides", () => {
    const arrived = `guard=${GUARD}&network=${NETWORK.name}&tab=telemetry&filter=blocked`;
    const focused = mergeEventParam(arrived, LOCATOR);
    assert.deepEqual(decodeEventLink(`?${focused}`).status, "ready");
    assert.equal(mergeEventParam(focused, null), arrived);
  });
});

describe("loadEventDetail", () => {
  test("re-reads the event from the chain and returns the decoded row", async () => {
    const { server, requests } = scriptedServer([
      { events: [{ ledger: 50 }, { ledger: 51 }, { ledger: 52 }], latestLedger: 60 },
    ]);
    const detail = await loadEventDetail({
      server,
      guard: GUARD,
      locator: { kind: "ledger", ledger: 51, transactionHash: hashAt(51), topic: HEARTBEAT },
    });
    assert.equal(detail.status, "found");
    assert.equal(detail.status === "found" ? detail.event.ledger : null, 51);
    assert.equal(
      requests[0]?.startLedger,
      51,
      "the lookup starts at the locator's own ledger, so it is bounded rather than a history scan",
    );
  });

  test("matches on the topic, not just the transaction", async () => {
    const { server } = scriptedServer([
      { events: [{ ledger: 51, topic: HEARTBEAT }], latestLedger: 60 },
    ]);
    const detail = await loadEventDetail({
      server,
      guard: GUARD,
      locator: { kind: "ledger", ledger: 51, transactionHash: hashAt(51), topic: AUTH_CHECKED },
    });
    assert.equal(detail.status, "unavailable");
    assert.equal(
      detail.status === "unavailable" ? detail.reason : null,
      "not_found",
      "one transaction commits several guard events; the wrong topic is a different row",
    );
  });

  test("distinguishes pruned history from an event that is not there", async () => {
    const pruned = await loadEventDetail({
      server: scriptedServer([{ events: [], latestLedger: 900, oldestLedger: 800 }]).server,
      guard: GUARD,
      locator: { kind: "ledger", ledger: 51, transactionHash: hashAt(51), topic: HEARTBEAT },
    });
    assert.equal(pruned.status, "unavailable");
    assert.equal(pruned.status === "unavailable" ? pruned.reason : null, "pruned");

    const absent = await loadEventDetail({
      server: scriptedServer([{ events: [{ ledger: 60 }], latestLedger: 900, oldestLedger: 10 }])
        .server,
      guard: GUARD,
      locator: { kind: "ledger", ledger: 51, transactionHash: hashAt(51), topic: HEARTBEAT },
    });
    assert.equal(absent.status === "unavailable" ? absent.reason : null, "not_found");
  });

  test("reports a failed read as unknown rather than absent", async () => {
    const server = {
      getLatestLedger: async () => {
        throw new Error("rpc down");
      },
      getEvents: async () => {
        throw new Error("rpc down");
      },
    } as unknown as rpc.Server;
    const detail = await loadEventDetail({
      server,
      guard: GUARD,
      locator: { kind: "ledger", ledger: 51, transactionHash: hashAt(51), topic: HEARTBEAT },
    });
    assert.equal(detail.status, "unavailable");
    assert.equal(detail.status === "unavailable" ? detail.reason : null, "read_failed");
    assert.match(detail.status === "unavailable" ? (detail.detail ?? "") : "", /rpc down/);
  });

  test("answers a diagnostic locator with zero RPC calls", async () => {
    const { server, requests } = scriptedServer([{ events: [{ ledger: 51 }], latestLedger: 60 }]);
    const detail = await loadEventDetail({
      server,
      guard: GUARD,
      locator: { kind: "diagnostic", digest: "a".repeat(64) },
    });
    assert.equal(detail.status === "unavailable" ? detail.reason : null, "never_committed");
    assert.deepEqual(requests, [], "a refusal was rolled back — there is nothing to ask about");
  });

  test("bounds its paging instead of walking the chain", async () => {
    // Every page is exactly full, so nothing short-circuits the loop: the only
    // thing that can stop this lookup is the cap.
    const full = {
      events: Array.from({ length: 200 }, (_, index) => ({ ledger: 100 + index })),
      latestLedger: 900,
      oldestLedger: 10,
    };
    const { server, requests } = scriptedServer([full]);
    const detail = await loadEventDetail({
      server,
      guard: GUARD,
      locator: { kind: "ledger", ledger: 51, transactionHash: hashAt(51), topic: HEARTBEAT },
      limit: 200,
    });
    assert.equal(requests.length, EVENT_DETAIL_MAX_PAGES, "the lookup stops at the cap");
    assert.equal(detail.status === "unavailable" ? detail.reason : null, "not_found");
    assert.match(
      detail.status === "unavailable" ? (detail.detail ?? "") : "",
      new RegExp(String(EVENT_DETAIL_MAX_PAGES)),
      "and says it ran out of pages rather than implying the whole chain was searched",
    );
  });

  test("reports not-found with the numbers behind it", async () => {
    const detail = await loadEventDetail({
      server: scriptedServer([{ events: [{ ledger: 60 }], latestLedger: 900, oldestLedger: 10 }])
        .server,
      guard: GUARD,
      locator: { kind: "ledger", ledger: 51, transactionHash: hashAt(51), topic: HEARTBEAT },
    });
    const text = detail.status === "unavailable" ? (detail.detail ?? "") : "";
    assert.match(text, /ledger 51/);
    assert.match(text, /900/, "the RPC's head belongs in the explanation");
  });

  test("a server that omits its retention boundary claims no pruning", async () => {
    const detail = await loadEventDetail({
      // No `oldestLedger` at all, and an empty page: nothing was found, but the
      // endpoint never said it had dropped history, so "pruned" would be invented.
      server: scriptedServer([{ events: [], latestLedger: 900 }]).server,
      guard: GUARD,
      locator: { kind: "ledger", ledger: 51, transactionHash: hashAt(51), topic: HEARTBEAT },
    });
    assert.equal(detail.status === "unavailable" ? detail.reason : null, "not_found");
  });
});

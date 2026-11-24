/**
 * Permalinks for one telemetry event (issue #485).
 *
 * An operator reading a decision in the feed needs to hand a teammate *that row*,
 * not "the feed, filtered, whenever you get to it". A row-level link is a
 * security-relevant artifact, though: one browser writes it and another opens it,
 * so everything in it is untrusted input. Three rules shape this module.
 *
 *   1. **A link carries an address, never a payload.** Exactly three parameters
 *      exist — `network`, `guard` and `event`. No decision, no amount, no agent
 *      address, no XDR, nothing that could be mistaken for key material: a copied
 *      URL has to be safe to paste into a chat or a ticket.
 *   2. **A link is a question, not an answer.** Opening one re-reads the chain
 *      ({@link loadEventDetail}) instead of trusting what this browser happens to
 *      remember. The feed buffer is capped at 250 rows and dies with the tab, so a
 *      link that resolved against browser state would quietly mean "the row I saw
 *      at the time I copied" — which is not a claim about the chain at all.
 *   3. **A link that cannot be answered says which way it failed.** "No such row"
 *      and "we could not look" are different facts, and only one of them is
 *      evidence about the guard. {@link EventUnavailableReason} keeps them apart.
 *
 * The locator
 * -----------
 *
 *   `event=<ledger>:<transactionHash>:<topic>`
 *
 * All three parts are load-bearing. The ledger sequence is what makes the row
 * findable at all: `getEvents` can only be asked forward from a start position, so
 * a locator without one cannot be re-read without scanning history from the
 * retention boundary. The transaction hash and the name topic make the row unique
 * *within* that ledger — one transaction commits several guard events (a heartbeat
 * call emits both `event_auth_checked` and `event_heartbeat`), and one ledger
 * closes many transactions.
 *
 * The SDK's own {@link guardEventId} (`ledger:<txHash>:<topic>`) is deliberately
 * not reused as the locator. It content-addresses a row so two pages of the same
 * stream de-duplicate, and for that job the ledger sequence is noise; a permalink
 * has the opposite requirement. The two formats agree on every field they share,
 * and {@link parseEventLocator} recognises the `diag:<sha256>` shape the SDK mints
 * for refusals, so a hand-written link of that shape is answered honestly ("a
 * refusal never reached a ledger") rather than reported as malformed.
 */

import { GUARD_EVENT_TOPICS } from "stellar-agent-guard-sdk";
import type { rpc } from "@stellar/stellar-sdk";
import { GUARD_QUERY_PARAM } from "./deeplink.ts";
import { looksLikeContractAddress } from "./instance.ts";
import { NETWORK } from "./network.ts";
import { GuardFeed, type TelemetryEvent } from "./telemetry.ts";

/** The query parameter a focused event link owns. */
export const EVENT_LINK_PARAM = "event";

/**
 * How many events one `getEvents` page may carry while re-reading a link. The same
 * default the historical range query uses (#148), so a link costs no more RPC load
 * than a range the operator can already ask for.
 */
export const EVENT_DETAIL_PAGE_LIMIT = 200;

/**
 * How many pages a re-read may walk forward before giving up. Bounded on purpose:
 * an event that is not within this reach of its own ledger start is not "missing",
 * it is somewhere the dashboard will not go looking on an operator's behalf, and
 * the detail says so rather than implying the chain was searched.
 */
export const EVENT_DETAIL_MAX_PAGES = 5;

/**
 * Ceiling on a locator read out of a URL. The real shape is ~106 characters, so
 * this only ever rejects junk — a megabyte of "locator" pasted into the address bar
 * should fail validation, not be fed to three regexes.
 */
const MAX_LOCATOR_LENGTH = 200;

/** The topics this build can name; anything else is not a guard event. */
const TOPIC_VOCABULARY: readonly string[] = Object.values(GUARD_EVENT_TOPICS);

/** A ledger sequence: digits, no sign, no leading zero, no float. */
const LEDGER_PATTERN = /^[1-9][0-9]{0,18}$/;

/** A 32-byte hash in hex — used for both the transaction hash and a diagnostic digest. */
const HASH_PATTERN = /^[0-9a-fA-F]{64}$/;

/** The prefix `guardEventId` gives a refused decision, which has no ledger anchor. */
const DIAGNOSTIC_PREFIX = "diag:";

/**
 * A validated event locator.
 *
 * `ledger` is the only shape a permalink can be *minted* for. `diagnostic` exists
 * because a URL can arrive carrying one: the SDK ids a refusal by content hash, and
 * an operator who copied such an id out of a debug view deserves to be told that a
 * refusal has no chain record, rather than that their link is malformed.
 */
export type EventLocator =
  | {
      readonly kind: "ledger";
      readonly ledger: number;
      /** Lower-cased hex, so matching against a chain read is a plain equality. */
      readonly transactionHash: string;
      readonly topic: string;
    }
  | { readonly kind: "diagnostic"; readonly digest: string };

/** The outcome of reading a locator string, in the shape `deeplink.ts` uses. */
export type LocatorParse =
  | { readonly status: "valid"; readonly locator: EventLocator }
  | { readonly status: "malformed"; readonly raw: string; readonly reason: string }
  | { readonly status: "absent" };

/**
 * Why a committed-event link cannot be answered.
 *
 * - `never_committed`: the locator names a refused decision. It was rolled back
 *   before broadcast, so there is nothing on chain to re-read. No RPC call is made.
 * - `pruned`: the event's ledger is older than what this RPC still keeps. True
 *   retention, stated as such.
 * - `not_found`: the RPC answered, and this guard's stream does not contain the
 *   event. Either the locator does not describe a real event or it belongs to a
 *   different contract than the `guard` in the link — which is why the link's guard
 *   is never overwritten by the locator's own address.
 * - `read_failed`: the read itself failed (timeout, unreachable RPC, malformed
 *   answer). Nothing is being claimed about the event.
 */
export type EventUnavailableReason = "never_committed" | "pruned" | "not_found" | "read_failed";

/** The result of re-reading the chain for one locator. */
export type EventDetail =
  | { readonly status: "found"; readonly event: TelemetryEvent }
  | {
      readonly status: "unavailable";
      readonly reason: EventUnavailableReason;
      /** The specific numbers or error text behind the reason; null when there are none. */
      readonly detail: string | null;
    };

/** A link that passed validation for every parameter it carries. */
export type EventLink =
  | {
      readonly status: "ready";
      readonly guard: string;
      readonly locator: EventLocator;
      /** The raw locator string, for the copy field — the operator's URL, unedited. */
      readonly raw: string;
    }
  | { readonly status: "absent" }
  | {
      readonly status: "invalid";
      /** Which parameter failed, so the panel can name it instead of saying "bad link". */
      readonly parameter: "guard" | "network" | "event";
      readonly reason: string;
    };

function malformed(raw: string, reason: string): LocatorParse {
  return { status: "malformed", raw, reason };
}

/**
 * Validate a locator string.
 *
 * Strictly: an unknown shape is rejected with the reason, never coerced. A ledger
 * sequence is bounds-checked as digits before `Number` runs, and the topic must be
 * one this build knows, so nothing read out of a URL reaches a query unvalidated.
 */
export function parseEventLocator(raw: string | null | undefined): LocatorParse {
  if (raw === null || raw === undefined) return { status: "absent" };
  const value = raw.trim();
  if (value === "") return { status: "absent" };
  if (value.length > MAX_LOCATOR_LENGTH) return malformed(value, "event locator too long");

  if (value.startsWith(DIAGNOSTIC_PREFIX)) {
    const digest = value.slice(DIAGNOSTIC_PREFIX.length);
    if (!HASH_PATTERN.test(digest))
      return malformed(value, "diagnostic locator digest is not 64 hex");
    return { status: "valid", locator: { kind: "diagnostic", digest: digest.toLowerCase() } };
  }

  const parts = value.split(":");
  if (parts.length !== 3) {
    return malformed(
      value,
      "expected <ledger>:<transaction hash>:<topic>, found " + parts.length + " parts",
    );
  }
  const [ledger, hash, topic] = parts as [string, string, string];
  if (!LEDGER_PATTERN.test(ledger)) return malformed(value, "ledger is not a positive integer");
  if (!HASH_PATTERN.test(hash)) return malformed(value, "transaction hash is not 64 hex");
  if (!TOPIC_VOCABULARY.includes(topic)) return malformed(value, "unknown guard event topic");
  return {
    status: "valid",
    locator: {
      kind: "ledger",
      ledger: Number(ledger),
      transactionHash: hash.toLowerCase(),
      topic,
    },
  };
}

/**
 * The locator for a row the feed is showing, or null when the row has none.
 *
 * Two shapes get no link, and both are honest refusals rather than gaps:
 *
 *   - a `diagnostic` row — a refusal, which by construction has no ledger record
 *     to point at (see the panel's explanation of refused decisions);
 *   - a committed row missing its ledger sequence or transaction hash, which the
 *     decoder can produce for an event the RPC answered without either. A locator
 *     built from those would be a link that cannot be found again.
 */
export function eventLocatorFor(event: TelemetryEvent): string | null {
  if (event.source !== "ledger") return null;
  const ledger = event.ledger;
  const hash = event.transactionHash;
  if (ledger === null || ledger === undefined || ledger < 1) return null;
  if (typeof hash !== "string" || !HASH_PATTERN.test(hash)) return null;
  const topic = event.topic;
  if (!TOPIC_VOCABULARY.includes(topic)) return null;
  return `${ledger}:${hash.toLowerCase()}:${topic}`;
}

/**
 * What a feed row can be linked to, or null when it cannot be linked at all.
 *
 * The guard comes from the row's own `contractId`, not from the console's current
 * selection: a row tailed from a second guard must link to *that* contract, or the
 * permalink would re-read the wrong stream and report a real event as missing.
 *
 * Two shapes get no link, and both are honest refusals rather than gaps:
 *
 *   - a `diagnostic` row — a refusal, which by construction has no ledger record
 *     to point at (the panel explains refused decisions instead);
 *   - a committed row missing its ledger sequence or transaction hash, or attributed
 *     to an address this build could not have loaded. A link minted from those would
 *     be a URL that cannot be found again, which is worse than no URL.
 */
export function eventLinkTargetFor(event: TelemetryEvent): { guard: string; raw: string } | null {
  const guard = event.contractId ?? "";
  if (!looksLikeContractAddress(guard)) return null;
  const raw = eventLocatorFor(event);
  return raw === null ? null : { guard, raw };
}

/**
 * The permalink query for one row, or null when no honest link exists.
 *
 * A relative URL, deliberately: the origin is whatever host this build is served
 * from, so a link copied from a preview deployment does not silently become a link
 * to production.
 */
export function eventHref(guard: string, raw: string): string | null {
  const query = eventLinkQuery(guard, raw);
  return query === null ? null : `/?${query}`;
}

/**
 * The three parameters a focused link is made of, in canonical order
 * (`network` → `guard` → `event`), or null if any one of them fails validation.
 *
 * Encoding re-validates rather than trusting its caller, because it is the last
 * place a string can be checked before it reaches someone else's browser.
 */
export function eventLinkQuery(guard: string, raw: string): string | null {
  if (!looksLikeContractAddress(guard)) return null;
  const parsed = parseEventLocator(raw);
  if (parsed.status !== "valid") return null;
  const params = new URLSearchParams();
  params.set("network", NETWORK.name);
  params.set(GUARD_QUERY_PARAM, guard);
  params.set(EVENT_LINK_PARAM, parsed.locator.kind === "ledger" ? raw : raw.trim());
  return params.toString();
}

/**
 * Read a focused-event link out of a search string.
 *
 * `absent` means this is an ordinary console URL. `invalid` names the first
 * parameter that failed, in the order the console needs it (guard before event:
 * an event locator cannot be looked up without knowing which contract to ask).
 * `network` is validated against this build — a link claiming any other network
 * cannot mean anything here, the same rule `urlState.ts` applies.
 */
export function decodeEventLink(search: string): EventLink {
  const params = new URLSearchParams(search);
  const raw = params.get(EVENT_LINK_PARAM);
  if (raw === null || raw.trim() === "") return { status: "absent" };

  const network = params.get("network");
  if (network !== null && network.trim() !== "" && network.trim().toLowerCase() !== NETWORK.name) {
    return {
      status: "invalid",
      parameter: "network",
      reason: `this build reads ${NETWORK.name}; the link asks for "${network.trim()}"`,
    };
  }

  const guard = params.get(GUARD_QUERY_PARAM);
  if (guard === null || guard.trim() === "") {
    return {
      status: "invalid",
      parameter: "guard",
      reason: "no guard address in the link, so there is no contract to ask",
    };
  }
  if (!looksLikeContractAddress(guard.trim())) {
    return {
      status: "invalid",
      parameter: "guard",
      reason: `"${guard.trim()}" is not a contract address`,
    };
  }
  if (params.getAll(EVENT_LINK_PARAM).length > 1) {
    return {
      status: "invalid",
      parameter: "event",
      reason: "the link repeats an event locator, and the two do not match",
    };
  }

  const parsed = parseEventLocator(raw);
  if (parsed.status !== "valid") {
    return {
      status: "invalid",
      parameter: "event",
      reason: parsed.status === "malformed" ? parsed.reason : "no event locator",
    };
  }
  return { status: "ready", guard: guard.trim(), locator: parsed.locator, raw: raw.trim() };
}

/**
 * Fold an event locator into a search string, leaving every other parameter alone.
 *
 * `null` deletes the parameter, which is how the panel closes itself: the link is
 * the panel's state, so dismissing the view must give back the URL the operator
 * arrived with. `URLSearchParams` preserves the order of untouched keys, and
 * `event` lands last, so a shared view URL (`?guard=…&tab=…&filter=…`) survives a
 * link round trip with its own parameters intact.
 *
 * Duplicate `event` parameters collapse to the one requested (or to none), because
 * an ambiguous link is not a link.
 */
export function mergeEventParam(search: string, raw: string | null): string {
  const params = new URLSearchParams(search);
  params.delete(EVENT_LINK_PARAM);
  if (raw !== null && raw !== "") params.set(EVENT_LINK_PARAM, raw);
  return params.toString();
}

/**
 * The event name {@link writeEventLink} dispatches after it changes the address bar.
 *
 * `history.replaceState` fires no `popstate`, so a component subscribed to browser
 * history alone would keep showing the previous link. This is the announcement that
 * closes that gap — the same reason a store needs an event of its own rather than a
 * shared one: only this module knows when it moved `event`.
 */
export const EVENT_LINK_EVENT = "guard-event-link";

/**
 * Focus or unfocus the detail view by writing the `event` parameter.
 *
 * `null` deletes it, which is the panel's close: the link *is* the panel's state, so
 * dismissing the view hands back the URL the operator arrived with.
 *
 * Only `event` is touched, and `urlState.ts` treats it as an unknown pass-through
 * key, so the two owners of the address bar cannot overwrite each other — a guard
 * switch keeps the open link, and opening a link keeps the tab and filter. No-op on
 * the server and when nothing would change, exactly as `writeUrlState` behaves.
 *
 * The caller is expected to pass a locator from {@link eventLocatorFor}, which
 * returns null for a row that cannot be linked; {@link decodeEventLink} validates
 * whatever reaches the address bar from anywhere else, including a hand-typed URL.
 */
export function writeEventLink(raw: string | null): void {
  if (typeof window === "undefined") return;
  const search = mergeEventParam(window.location.search, raw);
  const next =
    search.length > 0
      ? `${window.location.pathname}?${search}${window.location.hash}`
      : `${window.location.pathname}${window.location.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next === current) return;
  window.history.replaceState(window.history.state, "", next);
  // `window.Event`, not the bare global: under a DOM harness the global constructor
  // can belong to a different realm than the window receiving the event, and a
  // cross-realm instance is rejected. In a browser the two are the same object.
  window.dispatchEvent(new window.Event(EVENT_LINK_EVENT));
}

/** The name `loadEventDetail` matches a page row against, normalised for comparison. */
function sameEvent(event: TelemetryEvent, locator: EventLocator & { kind: "ledger" }): boolean {
  return (
    event.ledger === locator.ledger &&
    (event.transactionHash ?? "").toLowerCase() === locator.transactionHash &&
    event.topic === locator.topic
  );
}

function failureText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Re-read one event from the chain, and say which way it failed if it did.
 *
 * The read goes through a throwaway {@link GuardFeed} rather than the live one, for
 * two reasons. The live feed's cursor is the thing that makes tailing correct —
 * moving it backwards to look at history would re-deliver or skip rows in a table
 * someone else is reading — and a failed lookup must not be able to disturb it. The
 * second reason is honesty: the throwaway feed starts from the locator's own ledger,
 * so the row it returns came from the chain just now, not from a buffer.
 *
 * `resetFrom(ledger)` is what turns `getEvents` into a bounded lookup: the first page
 * starts at the event's ledger, so the target is at the head of the response rather
 * than somewhere behind an unbounded scan. Forward paging is capped at
 * {@link EVENT_DETAIL_MAX_PAGES} pages, and running out of pages is reported as
 * `not_found` with the numbers in the detail rather than as a silent miss.
 */
export async function loadEventDetail(input: {
  server: rpc.Server;
  guard: string;
  locator: EventLocator;
  limit?: number;
  maxPages?: number;
}): Promise<EventDetail> {
  if (input.locator.kind === "diagnostic") {
    return {
      status: "unavailable",
      reason: "never_committed",
      detail:
        "the locator names a refused decision, which the guard rolled back before broadcast — " +
        "it has no transaction and no ledger record to re-read",
    };
  }
  const locator = input.locator;
  const limit = input.limit ?? EVENT_DETAIL_PAGE_LIMIT;
  const maxPages = input.maxPages ?? EVENT_DETAIL_MAX_PAGES;
  const feed = new GuardFeed(input.server, input.guard);
  feed.resetFrom(locator.ledger);
  let pages = 0;
  let oldestLedger: number | null = null;
  let latestLedger: number | null = null;
  try {
    for (let page = 0; page < maxPages; page += 1) {
      const result = await feed.pollOnce(limit);
      pages += 1;
      oldestLedger = result.oldestLedger;
      latestLedger = result.latestLedger;

      const match = result.events.find((event) => sameEvent(event, locator));
      if (match !== undefined) return { status: "found", event: match };

      // The RPC cannot answer for a ledger it no longer holds. Checked after the
      // find, because a server that retained less than the locator's ledger can
      // still be serving a page that happens to contain the row. A server that
      // answers without a retention boundary is not claiming to have pruned
      // anything, so no pruning is inferred from an absent field.
      const oldest = result.oldestLedger;
      if (oldest !== null && oldest > locator.ledger) {
        return {
          status: "unavailable",
          reason: "pruned",
          detail: `this RPC keeps events from ledger ${oldest}; the link is ledger ${locator.ledger}`,
        };
      }
      // A short page is the end of this guard's stream from the start ledger, so
      // paging further cannot reach the event either.
      if (result.events.length < limit) {
        return {
          status: "unavailable",
          reason: "not_found",
          detail:
            `guard ${input.guard} emitted no such event at ledger ${locator.ledger} ` +
            `(RPC at ledger ${result.latestLedger}, oldest ${oldest ?? "unknown"})`,
        };
      }
    }
  } catch (error) {
    return { status: "unavailable", reason: "read_failed", detail: failureText(error) };
  } finally {
    // A stopped feed ignores any in-flight completion, so a late page from a
    // cancelled lookup can never be mistaken for an answer.
    feed.stop();
  }
  return {
    status: "unavailable",
    reason: "not_found",
    detail: `not within ${pages} pages of ledger ${locator.ledger} (oldest ${oldestLedger}, latest ${latestLedger})`,
  };
}

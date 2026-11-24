"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { describeGuardEvent, explainReason } from "stellar-agent-guard-sdk";
import {
  EVENT_LINK_EVENT,
  decodeEventLink,
  eventLinkQuery,
  loadEventDetail,
  writeEventLink,
  type EventDetail,
  type EventLink,
  type EventUnavailableReason,
} from "../lib/guard/eventLink.ts";
import type { TelemetryEvent } from "../lib/guard/telemetry.ts";
import { formatEventTimestamp } from "../lib/guard/time.ts";
import { useGuard } from "./GuardProvider.tsx";
import { CopyButton } from "./CopyButton.tsx";
import { ErrorBlock, Skeleton, short } from "./bits.tsx";

/**
 * What each failure of the re-read means to the operator, in their terms.
 *
 * Four separate strings rather than one fallback, because the four are different
 * claims about the world: one says the event never existed on chain, one says it
 * existed and is gone, one says this guard did not emit it, and one says nobody
 * knows. Collapsing them would let "the RPC timed out" be read as "the guard is
 * quiet", which is the misreading this panel exists to prevent.
 */
const UNAVAILABLE_COPY: Record<EventUnavailableReason, string> = {
  never_committed:
    "This link names a refused decision. The guard returned an error, which rolled the call back " +
    "before broadcast, so there is no transaction and no ledger record to reopen.",
  pruned:
    "This event is older than what the RPC still keeps. Its ledger has left the retention window, " +
    "so this endpoint cannot re-read it — the row was real when it was first shown.",
  not_found:
    "The chain was asked, and this guard's events do not contain it. A link naming a real event on " +
    "a different contract fails here too: the guard in the link is the contract that gets asked.",
  read_failed:
    "The re-read did not complete. This says nothing about the event — the RPC may be unreachable " +
    "or slow, and the answer is unknown rather than absent.",
};

/**
 * The focused-event link as it stands in the address bar.
 *
 * `useSyncExternalStore` for the same reason `useDemoMode` does: the query string
 * only exists in the browser, so reading it during render makes the server and the
 * client disagree and desynchronises hydration. The server snapshot is "no link",
 * which is also the honest answer — nothing has been looked up yet. The subscribe
 * side listens for `popstate` *and* {@link EVENT_LINK_EVENT}, because the
 * `replaceState` this panel writes through fires neither of the former on its own.
 */
function useEventLinkSearch(): string {
  const subscribe = useCallback((onStoreChange: () => void) => {
    window.addEventListener("popstate", onStoreChange);
    window.addEventListener(EVENT_LINK_EVENT, onStoreChange);
    return () => {
      window.removeEventListener("popstate", onStoreChange);
      window.removeEventListener(EVENT_LINK_EVENT, onStoreChange);
    };
  }, []);
  const getSnapshot = useCallback(() => window.location.search, []);
  const getServerSnapshot = useCallback(() => "", []);
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * Re-read the chain for the link in the address bar and hold the answer.
 *
 * One request per link, not per render: the effect keys on `key`, which is the
 * guard and the locator together — the whole input — plus the manual re-read
 * counter. The answer is stored *with* the key it belongs to rather than in a bare
 * state slot, so switching from one link to another cannot flash the previous
 * event's row while the new read is in flight, and a late response cannot be
 * mistaken for the current one.
 */
function useEventDetail(link: EventLink): {
  detail: EventDetail | null;
  reload: () => void;
} {
  const { server } = useGuard();
  const [held, setHeld] = useState<{ key: string; detail: EventDetail } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const key = link.status === "ready" ? `${link.guard}|${link.raw}` : null;
  const reload = useCallback(() => setAttempt((current) => current + 1), []);

  useEffect(() => {
    if (link.status !== "ready") return;
    const asked = `${link.guard}|${link.raw}`;
    void (async () => {
      const answer = await loadEventDetail({ server, guard: link.guard, locator: link.locator });
      setHeld({ key: asked, detail: answer });
    })();
  }, [key, attempt, server, link]);

  return { detail: held !== null && held.key === key ? held.detail : null, reload };
}

/**
 * The focused event detail (issue #485).
 *
 * Renders only when the address bar carries `?event=…`, and only ever from a fresh
 * chain read. That is the whole point: a copied link reopens *this* event on *this*
 * guard, and if the chain cannot confirm it the panel says which way the lookup
 * failed rather than showing an empty box that reads as "nothing happened".
 *
 * Nothing is remembered between loads — no row content cached, no assumption that
 * the feed on screen still holds the row. The URL is the input and the RPC is the
 * authority, and the read is issued from this browser: a server-rendered detail
 * would need a server that talks to the chain, and this dashboard signs nothing and
 * proxies nothing (`check:no-server`).
 */
export function EventDetailPanel() {
  const search = useEventLinkSearch();
  const link = useMemo(() => decodeEventLink(search), [search]);
  const { detail, reload } = useEventDetail(link);
  if (link.status === "absent") return null;

  return (
    <div className="panel" data-testid="event-detail" style={{ marginTop: 10 }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <h3>Event detail</h3>
        <button
          type="button"
          className="secondary"
          onClick={() => writeEventLink(null)}
          title="Close this view. The address bar goes back to the URL you arrived with."
        >
          Close
        </button>
      </div>

      {link.status === "invalid" && (
        <ErrorBlock
          title={`This event link is not usable: the ${link.parameter} parameter was rejected`}
          detail={link.reason}
        />
      )}

      {link.status === "ready" && (
        <>
          <p className="tiny muted">
            Guard <span className="mono">{short(link.guard, 8, 6)}</span> · locator{" "}
            <span className="mono">{link.raw}</span>. Re-read from the chain just now, not from the
            feed buffer.
          </p>
          <div className="row" style={{ gap: 8 }}>
            <PermalinkCopy guard={link.guard} raw={link.raw} />
            <button type="button" className="secondary" onClick={reload}>
              Re-read
            </button>
          </div>
          {detail === null && (
            <div aria-busy="true">
              <Skeleton lines={2} />
            </div>
          )}
          {detail?.status === "found" && <EventDetailFields event={detail.event} />}
          {detail?.status === "unavailable" && (
            <ErrorBlock
              title="This event is unavailable"
              detail={
                detail.detail === null
                  ? UNAVAILABLE_COPY[detail.reason]
                  : `${UNAVAILABLE_COPY[detail.reason]} (${detail.detail})`
              }
            />
          )}
        </>
      )}
    </div>
  );
}

/**
 * Copy the focused permalink — the three parameters and nothing else.
 *
 * Deliberately not `window.location.href`: the address bar may also hold the active
 * tab, the verdict filter or a `?demo=true` this operator happened to be using.
 * Those are this browser's view state, not part of the event's identity, and pasting
 * them into a ticket sends a teammate to a screen rather than to a fact. Re-encoded
 * through {@link eventLinkQuery}, so what gets copied is a link this build accepts.
 */
function PermalinkCopy({ guard, raw }: { guard: string; raw: string }) {
  const query = eventLinkQuery(guard, raw);
  if (query === null) {
    return (
      <span className="tiny muted">this link failed to re-encode, so there is nothing to copy</span>
    );
  }
  return <CopyButton value={`${window.location.origin}/?${query}`} label="event permalink" />;
}

/**
 * The event as the chain described it, in the fields an operator quotes.
 *
 * `data` renders through {@link safeData} because decoded 64-bit amounts arrive as
 * `bigint`, which `JSON.stringify` throws on — the same rule the audit export
 * applies for the same reason. A number the browser cannot print is worse than a
 * number printed as text.
 */
function EventDetailFields({ event }: { event: TelemetryEvent }) {
  const timestamp = formatEventTimestamp(event.ledgerClosedAt ?? event.observedAt ?? null);
  const decision = event.decision;
  return (
    <div className="grid" style={{ marginTop: 8 }}>
      <div className="stat">
        <span className="k">Event</span>
        <div className="v small">{describeGuardEvent(event)}</div>
        <div className="n mono">{event.topic}</div>
      </div>
      <div className="stat">
        <span className="k">Decision</span>
        <div className="v small">{decision ? decision.result : "—"}</div>
        {decision?.reason ? <div className="n">{explainReason(decision.reason)}</div> : null}
      </div>
      <div className="stat">
        <span className="k">Ledger</span>
        <div className="v">{event.ledger ?? "—"}</div>
        <div className="n mono">{timestamp ? `${timestamp.utc} UTC` : "—"}</div>
      </div>
      <div className="stat">
        <span className="k">Transaction</span>
        <div className="v small mono">
          {short(event.transactionHash ?? "never broadcast", 12, 8)}
        </div>
      </div>
      <div className="stat" style={{ gridColumn: "1 / -1" }}>
        <span className="k">Data</span>
        <div className="v small mono">{safeData(event.data)}</div>
      </div>
    </div>
  );
}

/** `JSON.stringify` over decoded event data, with 64-bit values kept exact as text. */
export function safeData(data: unknown): string {
  try {
    return (
      JSON.stringify(data, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value,
      ) ?? String(data)
    );
  } catch {
    return String(data);
  }
}

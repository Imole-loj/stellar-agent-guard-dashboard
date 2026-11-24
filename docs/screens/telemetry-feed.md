# Telemetry Feed Component

`TelemetryFeed` tails contract events from Soroban RPC:

- Queries `getEvents` with `event_auth_checked` topic filter.
- Decodes contract addresses, decision results (`allowed` or `blocked`), reason codes, and timestamps.
- Color-coded badges highlight blocked transactions and policy violations in real-time.

## Row severity tiers

Rows are tiered so a block is findable by looking, not by reading every row. The tier
rides on the `<tr>` as a class and a `data-severity` attribute; `data-stream` carries the
SDK's stream discriminator (`ledger` or `diagnostic`).

| Tier | Row | Marker | Wording already in the row |
| --- | --- | --- | --- |
| `blocked` | The guard refused the call | danger left rule + tinted surface | the reason badge, e.g. `per_tx_cap_exceeded` |
| `allowed` | The guard authorized the call | none — deliberately neutral | the `allowed` badge |
| `diagnostic` | A refused-simulation row with no decision of its own | warn left rule | the `diagnostic` source chip |
| `lifecycle` | Heartbeat / admin event, no decision made | none — deliberately neutral | the event name, and `—` for the decision |

Severity is derived from the fields the decoder already produced — `decision.result` and
`event.source` (`stellar-agent-guard-sdk`, `dist/telemetry.d.ts`) — so no topic or reason
string is parsed per render, and every tier is stated in words as well as in colour.

There is **no sound**. An operator console runs unattended and muted, and a noise that can
only be silenced in the tab that made it is not an alert.

## Pausing and resuming

`Pause stream` freezes the table; it does not freeze the feed.

- What pause protects: the rows on screen, the filters applied to them, and the poll
  cursor. The poll loop keeps running behind the frozen table, so the panel still names
  the last successful poll while paused — "frozen" and "dead" would otherwise look
  identical.
- What arrives during a pause is queued, not shown and not discarded. The notice counts
  the queue, the button reads `Resume (n)`, and resume prepends the queue in arrival
  order. A queued event whose age takes it past the buffer limit is reported as dropped
  in the same notice rather than vanishing.
- Re-clearing with `Clear buffer` empties the list and likewise keeps the cursor, so a
  cleared feed does not re-read history.

Proof: `tests/unit/telemetryControls.test.ts` for the buffer transitions, and
`tests/e2e/telemetryPause.spec.ts` for the operator-visible contract — including that a
pause does not re-fetch the page it already consumed, which the de-duplicated table hides.

## A link to one event

Every row the console can address on chain carries `link to this row`. It focuses that
event in place — the address bar gains an `event` parameter and the feed, the wallet
session and any form draft survive the click — and the same URL is shareable.

- The link carries three parameters and nothing else: `network`, `guard`, and an `event`
  locator of `<ledger>:<transaction hash>:<topic>`. There is no event payload in the URL,
  so a shared link cannot carry a secret key, a signed envelope or transaction contents.
  Codec and validation: `lib/guard/eventLink.ts`.
- Opening a link re-reads the event from Soroban RPC in the browser, through a throwaway
  feed with a bounded number of pages. The live tail's cursor is not touched, and no
  server is involved: the console stays client-only (`npm run check:no-server`).
- An event that cannot be produced is reported by *why*, in four distinct wordings,
  rather than as a blank panel: never committed on chain (a diagnostic refusal has no
  ledger to re-read), pruned past the RPC's retention boundary, not found in the guard's
  stream, or the read failed.
- Rows the console cannot address render no link rather than one that would fail.

Proof: `tests/unit/eventLink.test.ts` for the codec, the parameter whitelist and each
unavailable reason; `tests/unit/eventDetailPanel.test.ts` for focus-without-navigation
and the panel's states.

## Bookmarks and notes on a row

A row can be bookmarked and annotated. Both are the operator's own record, not a fact
about the guard, and the panel says that in words wherever either appears.

- One record per row, keyed on the event identity the feed already uses (`event.id`):
  `ledger:<txHash>:<topic>` for a committed row, `diag:<sha256>` for a refusal. Storage
  is scoped to `(network, guard)`, so a bookmark made against one guard is never applied
  to a same-looking id under another, and removing the instance deletes its marks.
- The mark lives **beside** the event, never on it. Every export surface in this console
  is a function of the `GuardEvent`s it is handed and reads no browser storage, which is
  what makes "a note is never exported, signed or sent to a webhook" true by construction
  instead of by review.
- Provenance is on screen, not implied by position: the row carries a `browser-local`
  marker and the panel states whose marks they are. A bookmark on a diagnostic row is
  spoken as one that has no ledger to re-read it from.
- A `Bookmarked only` view narrows the table to saved rows, and the count distinguishes
  what is in view from what is stored — a mark filtered out by a verdict filter would
  otherwise read as a lost mark.
- Limits refuse rather than evict: 500 characters per note, 200 marks per guard. A note
  containing a string shaped like a secret key is rejected inline with the draft kept,
  and the rejection never repeats the text back.
- Rows the feed cannot address render no controls and say why, rather than offering a
  mark that would attach to the wrong event.

Proof: `tests/unit/eventMarks.test.ts` for identity, scoping, the versioned envelope,
each refusal and the no-export read log; `tests/unit/telemetryFeed.test.ts` for what the
operator sees and hears, including that a mark adds no live region of its own.


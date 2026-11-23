import assert from "node:assert/strict";
import { afterEach, before, describe, it } from "node:test";
import type { ContextType } from "react";
import type { GuardEvent } from "stellar-agent-guard-sdk";
import { installDom, loadReact, sleep, type Act } from "./domHarness.ts";
import { TelemetryAlerts } from "../../components/TelemetryAlerts.tsx";
import { GuardContext, GuardEventsContext } from "../../components/GuardProvider.tsx";
import {
  ALERT_DEDUPE_STORAGE_KEY,
  ALERT_SETTINGS_STORAGE_KEY,
  alertDedupeScopeKey,
  alertEventKey,
} from "../../lib/guard/audioAlert.ts";
import { NETWORK } from "../../lib/guard/network.ts";
import { withIdentity } from "../mocks/eventFixtures.ts";

/**
 * The alerts panel, as the operator experiences it (#313, #314).
 *
 * The pure library tests cover what a key is made of and what a state means;
 * this file covers the two things only the component can get wrong: *when* it
 * asks the browser for permission, and whether what it prints describes what the
 * channels can actually do. Both are failures an operator cannot see coming —
 * a prompt on every load, or an "armed" pill beside a notification that will
 * never appear.
 *
 * Lives under `tests/unit` because that is the directory `npm test` runs: a
 * component test filed under `tests/components` is not part of the CI gate.
 */

installDom();

type GuardContextValue = NonNullable<ContextType<typeof GuardContext>>;

const GUARD = "CAYJZT4XH5SWDXNR7MZJCCUBIDAT2KZDDUTZ7OZQEMKCPJGD4P3X4CU7";
const OTHER_GUARD = "CBNFGGOLGQNOB4DQ3LXW6LZVKPDPFVWHY6PZGZ2QZGVDUQZNLVQFMRPH";

let react: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let act: Act;

before(async () => {
  const loaded = await loadReact();
  react = loaded.react;
  createRoot = loaded.createRoot;
  act = loaded.act;
});

afterEach(() => {
  document.body.innerHTML = "";
  window.localStorage.clear();
  window.sessionStorage.clear();
  delete (window as unknown as { Notification?: unknown }).Notification;
});

/** A refusal the guard actually made, in the shape the feed delivers. */
function blockedEvent(overrides: Partial<GuardEvent> = {}): GuardEvent {
  return withIdentity({
    kind: "auth_checked",
    topic: "event_auth_checked",
    source: "ledger",
    contractId: GUARD,
    ledger: 100,
    ledgerClosedAt: "2026-09-25T12:00:00.000Z",
    transactionHash: "a".repeat(64),
    decision: { result: "blocked", reason: "per_tx_cap_exceeded", source: "ledger" },
    data: {},
    ...overrides,
  });
}

interface NotificationCalls {
  prompts: number;
  titles: string[];
}

/**
 * `window.Notification` as a browser that answers with `init.permission`, and
 * then with whatever the prompt decided.
 *
 * `permission` is a mutable static for exactly the reason the library reads it
 * live: an operator clicking Allow in the prompt changes it mid-session.
 */
function installNotifications(
  init: {
    permission?: string;
    grantOnAsk?: boolean;
    denyOnAsk?: boolean;
    throwOnShow?: boolean;
  } = {},
): NotificationCalls {
  const calls: NotificationCalls = { prompts: 0, titles: [] };
  class FakeNotification {
    static permission = init.permission ?? "default";
    static requestPermission(): Promise<string> {
      calls.prompts += 1;
      if (init.grantOnAsk) FakeNotification.permission = "granted";
      if (init.denyOnAsk) FakeNotification.permission = "denied";
      return Promise.resolve(FakeNotification.permission);
    }
    constructor(title: string, _options: Record<string, unknown>) {
      if (init.throwOnShow) throw new Error("notifications disabled by enterprise policy");
      calls.titles.push(title);
    }
  }
  (window as unknown as { Notification?: unknown }).Notification = FakeNotification;
  return calls;
}

async function mountPanel(
  options: {
    events?: GuardEvent[];
    guards?: string[];
    audio?: boolean;
    desktop?: boolean;
  } = {},
) {
  window.localStorage.setItem(
    ALERT_SETTINGS_STORAGE_KEY,
    JSON.stringify({
      audio: options.audio ?? false,
      desktop: options.desktop ?? false,
      volume: 0.4,
    }),
  );

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  function contextFor(guards: string[]): GuardContextValue {
    return {
      guard: GUARD,
      instances: [],
      feed: {
        watching: true,
        latestLedger: 1_000,
        error: null,
        lastPolledAt: null,
        guards: guards.map((guard) => ({ guard, label: guard })),
        capped: 0,
        cappedLabels: [],
      },
      stream: { paused: false, pendingCount: 0, dropped: 0 },
      startWatching: () => {},
      stopWatching: () => {},
      clearEvents: () => {},
      pauseStream: () => {},
      resumeStream: () => {},
      queryRange: async () => {},
      rangeLabel: null,
    } as unknown as GuardContextValue;
  }

  /**
   * A new poll page. The array is always a fresh one, because that is what the
   * feed does: the same rows arrive again inside a new list, and the panel has
   * to tell the two apart.
   */
  async function poll(events: GuardEvent[], guards: string[] = [GUARD]) {
    await act(async () => {
      root.render(
        react.createElement(
          GuardContext.Provider,
          { value: contextFor(guards) },
          react.createElement(
            GuardEventsContext.Provider,
            { value: events },
            react.createElement(TelemetryAlerts),
          ),
        ),
      );
    });
    await act(async () => {
      await sleep(0);
    });
  }

  await poll(options.events ?? [], options.guards ?? [GUARD]);

  return {
    container,
    poll,
    state(testid: string): string {
      return container.querySelector(`[data-testid="${testid}"]`)?.textContent ?? "";
    },
    button(label: RegExp): HTMLButtonElement {
      // Matched by pattern, not by wording: the same control reads "Enable
      // notifications" or "Disable notifications" depending on the preference,
      // and a test that looked up the label would be testing its own string.
      const found = Array.from(container.querySelectorAll("button")).find((entry) =>
        label.test(entry.textContent ?? ""),
      );
      assert.ok(found, `expected a button labelled ${label}`);
      return found;
    },
    async click(label: RegExp) {
      await act(async () => {
        this.button(label).click();
        await sleep(0);
      });
    },
    dedupeRecord(): { scope: string; keys: string[] } | null {
      const raw = window.sessionStorage.getItem(ALERT_DEDUPE_STORAGE_KEY);
      return raw ? (JSON.parse(raw) as { scope: string; keys: string[] }) : null;
    },
    async unmount() {
      await act(async () => {
        root.unmount();
      });
    },
  };
}

describe("the alerts panel", () => {
  it("never asks the browser for permission on load, only on a click", async () => {
    const calls = installNotifications({ permission: "default" });
    const panel = await mountPanel({ desktop: true });

    // The stored preference is restored, so the panel says "on" — and still has
    // not prompted. Re-prompting on every load is how a console gets its
    // permission permanently revoked by an annoyed operator.
    assert.equal(calls.prompts, 0, "a page load must not spend the browser's one prompt");
    assert.match(panel.state("desktop-alert-state"), /not yet permitted/i);

    await panel.click(/Disable notifications/);
    assert.equal(calls.prompts, 0, "turning a channel off never asks for permission");

    await panel.click(/Enable notifications/);
    assert.equal(calls.prompts, 1, "exactly one prompt per explicit request");
    await panel.unmount();
  });

  it("alerts once across repeated poll pages of the same refusal", async () => {
    const calls = installNotifications({ permission: "granted" });
    const refusal = blockedEvent();
    const panel = await mountPanel({ desktop: true, events: [refusal] });
    assert.equal(calls.titles.length, 1);

    await panel.poll([refusal]);
    await panel.poll([refusal]);
    assert.equal(
      calls.titles.length,
      1,
      "the 5-second poll re-delivering one block must not re-notify it",
    );

    const next = blockedEvent({ ledger: 101, transactionHash: "b".repeat(64) });
    await panel.poll([next, refusal]);
    assert.equal(calls.titles.length, 2, "a genuinely new refusal still gets through");
    await panel.unmount();
  });

  it("writes what it alerted on down, so a reload of the tab stays quiet", async () => {
    const calls = installNotifications({ permission: "granted" });
    const refusal = blockedEvent();
    const panel = await mountPanel({ desktop: true, events: [refusal] });
    assert.equal(calls.titles.length, 1);

    const record = panel.dedupeRecord();
    assert.ok(record, "the identities are recorded before the tab can be refreshed");
    assert.equal(record.scope, alertDedupeScopeKey({ network: NETWORK.name, guards: [GUARD] }));
    assert.deepEqual(record.keys, [alertEventKey(refusal)]);
    await panel.unmount();

    // The reload: the feed re-primes from the same ledger history, the record is
    // still in `sessionStorage`, and the operator hears nothing twice.
    const reloaded = await mountPanel({ desktop: true, events: [refusal] });
    assert.equal(calls.titles.length, 1, "a reload must not re-chime this tab's own history");
    // And it says "permitted", not "delivering": this tab has not been asked to
    // show anything since the refresh, so a delivery claim would be invented.
    assert.match(reloaded.state("desktop-alert-state"), /permitted/i);
    assert.doesNotMatch(reloaded.state("desktop-alert-state"), /delivering/i);
    await reloaded.unmount();
  });

  it("starts the record over when the watched guard set changes", async () => {
    const calls = installNotifications({ permission: "granted" });
    const refusal = blockedEvent();
    const panel = await mountPanel({ desktop: true, events: [refusal] });
    assert.equal(calls.titles.length, 1);

    // A different watch list is a different stream: the record scoped to the
    // old one says nothing about whether this tab has alerted on these events.
    await panel.poll([refusal], [GUARD, OTHER_GUARD]);
    assert.equal(calls.titles.length, 2, "the new scope starts with an empty record");
    assert.equal(
      panel.dedupeRecord()?.scope,
      alertDedupeScopeKey({ network: NETWORK.name, guards: [GUARD, OTHER_GUARD] }),
      "and the record it writes is the new scope's, not the old one's",
    );

    await panel.poll([refusal], [GUARD, OTHER_GUARD]);
    assert.equal(calls.titles.length, 2, "within the new scope it dedupes again");
    await panel.unmount();
  });

  it("says when the browser, not the operator, is what stops a notification", async () => {
    const calls = installNotifications({ permission: "denied" });
    const panel = await mountPanel({ desktop: true, events: [blockedEvent()] });

    // The switch is on because the operator left it on. Reporting "armed" alone
    // would imply a protection the tab cannot provide.
    assert.match(panel.state("desktop-alert-state"), /blocked by the browser/i);
    assert.match(panel.state("desktop-alert-state"), /site settings/i);
    assert.equal(panel.button(/notifications/).disabled, true);
    assert.equal(calls.titles.length, 0, "a denied permission is never even attempted");
    await panel.unmount();
  });

  it("reports a delivery the browser refused instead of swallowing the failure", async () => {
    installNotifications({ permission: "granted", throwOnShow: true });
    const panel = await mountPanel({ desktop: true, events: [blockedEvent()] });

    assert.match(panel.state("desktop-alert-state"), /could not be shown/i);
    assert.match(panel.state("notification-delivery"), /refused to create it/i);
    await panel.unmount();
  });

  it("does not claim the chime has sounded before the page has been clicked", async () => {
    const panel = await mountPanel({ audio: true, events: [blockedEvent()] });
    // Restored preference, no gesture in this tab: the pill legitimately reads
    // "armed" while the audio row admits the browser has not allowed a sound.
    assert.match(panel.state("chime-alert-state"), /has not sounded/i);
    assert.match(panel.state("chime-alert-state"), /click/i);
    assert.match(panel.container.textContent ?? "", /armed/);
    await panel.unmount();
  });

  it("uses a permission granted mid-session for the next alert", async () => {
    const calls = installNotifications({ permission: "default", grantOnAsk: true });
    const panel = await mountPanel({ events: [] });

    await panel.click(/Enable notifications/);
    const later = blockedEvent({ ledger: 200, transactionHash: "c".repeat(64) });
    await panel.poll([later]);

    assert.equal(
      calls.titles.length,
      1,
      "the browser now allows notifications, so the panel must not keep refusing them",
    );
    assert.match(panel.state("desktop-alert-state"), /delivering/i);
    await panel.unmount();
  });
});

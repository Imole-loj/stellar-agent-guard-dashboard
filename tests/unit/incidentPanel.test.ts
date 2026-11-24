/**
 * The incident actions panel as the operator meets it (#527).
 *
 * `incidentActions.test.ts` pins the decision; this file pins the three things
 * only a render can prove:
 *
 *   - The panel performs no write. Its freeze row *moves focus* to Emergency's
 *     existing button — it must not click it, because clicking would skip the
 *     acknowledgement that button's own dialog imposes. The dialog staying shut
 *     is the assertion that matters here.
 *   - A state the chain could not answer produces no buttons. Not greyed ones —
 *     none, each with its reason in words.
 *   - The verification block reports what a re-read said, and never more than
 *     that: a failed read is not a confirmation, an agreement is not a success,
 *     and a reply for a guard the operator has left is not information.
 *
 * The verification read is injected through `ops`, the same seam `PanicPanel`
 * uses: what the panel *says* around a read is a property of the panel, and a
 * test must be able to check it without an RPC.
 */

import assert from "node:assert/strict";
import { test, before, afterEach } from "node:test";
import type { ContextType, ReactElement } from "react";
import { installDom, loadReact, sleep, type Act } from "./domHarness.ts";
import { IncidentPanel, type IncidentPanelOps } from "../../components/IncidentPanel.tsx";
import { PanicPanel } from "../../components/PanicPanel.tsx";
import { GuardContext, GuardEventsContext } from "../../components/GuardProvider.tsx";
import { clearAnnouncements, pendingAnnouncements } from "../../lib/guard/useAnnounce.ts";
import { WRITE_DISABLED_HINT } from "../../lib/guard/observerMode.ts";
import { PHASE1_ARTIFACT } from "../../lib/guard/network.ts";
import type { GuardSnapshot } from "../../lib/guard/guardOps.ts";
import type { ReadResult } from "../../lib/guard/chain.ts";
import type { GuardStatus } from "stellar-agent-guard-sdk";

installDom();

const GUARD = PHASE1_ARTIFACT.guard;
const OTHER = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAK4L";
const ADMIN = "GAOBCRXTCO4ZCBNHALJUMJJ5JDXNOUZ7U6VZJX4UBTXAHQEO66IPU6PH";
const READ_AT = "2026-11-23T10:00:00.000Z";

/** The sentence `evaluateOffline` produces for a failed live read (issue #348). */
const PREFLIGHT_SENTENCE =
  "The live read a write must preflight failed, so the console will not submit blind. Retry the read; write actions re-enable as soon as it succeeds.";

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
  clearAnnouncements();
});

function statusValue(overrides: Partial<GuardStatus> = {}): GuardStatus {
  return {
    has_policy: true,
    admin_frozen: false,
    heartbeat_expired: false,
    last_heartbeat: 1_700_000_000n,
    now: 1_700_000_060n,
    ...overrides,
  };
}

function snapshotWith(status: ReadResult<GuardStatus>): GuardSnapshot {
  return {
    guard: GUARD,
    fetchedAt: READ_AT,
    status,
    policy: { ok: true, value: null },
    window: { ok: true, value: null },
    identity: {
      ok: true,
      value: { reportedWasmHash: "abc123", fetchedSha256: "abc123", bytes: 39_673, match: true },
    },
  };
}

const healthy = snapshotWith({ ok: true, value: statusValue(), readAt: READ_AT });
const frozen = snapshotWith({
  ok: true,
  value: statusValue({ admin_frozen: true }),
  readAt: READ_AT,
});
const unreadable = snapshotWith({ ok: false, error: "rpc: connection reset" });

interface TestContext {
  guard: string;
  server: unknown;
  wallet: unknown;
  observer: boolean;
  snapshot: GuardSnapshot | null;
  snapshotError: string | null;
  refreshing: boolean;
  refresh: () => Promise<void>;
  signer: () => never;
  signCalls: { value: number };
}

/**
 * A guard context carrying only what this panel reads, plus a `signer` that
 * counts calls so "this panel signs nothing" is a measurement rather than a
 * reading of the JSX.
 */
function contextFor(
  snapshot: GuardSnapshot | null,
  options: { observer?: boolean; guard?: string } = {},
): TestContext {
  const signCalls = { value: 0 };
  return {
    guard: options.guard ?? GUARD,
    server: { endpoint: "https://rpc.test/history" },
    wallet: options.observer
      ? null
      : { address: ADMIN, networkPassphrase: "p", network: "testnet" },
    observer: options.observer ?? false,
    snapshot,
    snapshotError: snapshot === null ? "getEvents: fetch failed" : null,
    refreshing: false,
    refresh: async () => {},
    signer: () => {
      signCalls.value += 1;
      throw new Error("the incident panel must never ask for a signer");
    },
    signCalls,
  };
}

type GuardContextValue = NonNullable<ContextType<typeof GuardContext>>;

interface Rendered {
  container: HTMLElement;
  rerender: (context: TestContext) => Promise<void>;
  unmount: () => Promise<void>;
}

async function render(
  panel: ReactElement,
  context: TestContext,
  withPanic = false,
): Promise<Rendered> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render_ = async (value: TestContext) => {
    await act(async () => {
      root.render(
        react.createElement(
          GuardEventsContext.Provider,
          { value: [] },
          react.createElement(
            GuardContext.Provider,
            { value: value as unknown as GuardContextValue },
            withPanic
              ? react.createElement(react.Fragment, null, react.createElement(PanicPanel), panel)
              : panel,
          ),
        ),
      );
    });
    await act(async () => {
      await sleep(60);
    });
  };
  await render_(context);
  return {
    container,
    rerender: render_,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function testid(container: HTMLElement, id: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

function offerRows(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>("[data-incident-offer]"));
}

function refusalRows(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>("[data-incident-refusal]"));
}

function handoffButton(container: HTMLElement, id: string): HTMLButtonElement {
  const row = container.querySelector<HTMLElement>(`[data-incident-offer="${id}"]`);
  assert.ok(row, `expected an offer row for ${id}`);
  const button = row.querySelector<HTMLButtonElement>("button");
  assert.ok(button, `expected the ${id} offer to hand off with a button`);
  return button;
}

function verifyButton(container: HTMLElement): HTMLButtonElement {
  return Array.from(container.querySelectorAll("button")).find((candidate) =>
    /Verify on chain/.test(candidate.textContent ?? ""),
  ) as HTMLButtonElement;
}

function pill(container: HTMLElement): Element {
  const block = testid(container, "incident-verification");
  assert.ok(block, "the verification block must be on the page");
  const shown = block.querySelector(".pill");
  assert.ok(shown, "the verdict must be labelled");
  return shown;
}

/** A `readStatus` seam that answers from a queue and records every call. */
function fakeOps(results: ReadResult<GuardStatus>[]): {
  ops: Partial<IncidentPanelOps>;
  calls: { guard: string; source?: string }[];
} {
  const calls: { guard: string; source?: string }[] = [];
  let index = 0;
  return {
    calls,
    ops: {
      readStatus: async (_server, guard, source) => {
        calls.push({ guard, ...(source === undefined ? {} : { source }) });
        const result = results[Math.min(index, results.length - 1)]!;
        index += 1;
        return result;
      },
    },
  };
}

// ── No buttons where the chain has no answer ────────────────────────────────

test("an observer session is offered nothing, and every action says why in the console's own words", async () => {
  const rendered = await render(
    react.createElement(IncidentPanel),
    contextFor(healthy, { observer: true }),
  );
  try {
    assert.equal(offerRows(rendered.container).length, 0);
    assert.equal(refusalRows(rendered.container).length, 3);
    assert.match(
      testid(rendered.container, "incident-no-offers")!.textContent ?? "",
      /No admin action is offered/,
    );
    for (const row of refusalRows(rendered.container)) {
      assert.ok(
        (row.textContent ?? "").includes(WRITE_DISABLED_HINT),
        "the reason must be the sentence every other disabled control uses",
      );
    }
  } finally {
    await rendered.unmount();
  }
});

test("a failed status read offers nothing, and the read's own error is the alert", async () => {
  const rendered = await render(react.createElement(IncidentPanel), contextFor(unreadable));
  try {
    // The asymmetry this panel deliberately does not take: freeze looks like the
    // safe action to keep, but Emergency's button is inert on this same state,
    // so offering it here would contradict the control beside it.
    assert.equal(offerRows(rendered.container).length, 0);
    const reasons = refusalRows(rendered.container).map((row) => row.textContent ?? "");
    assert.ok(reasons.every((reason) => reason.includes(PREFLIGHT_SENTENCE)));
    assert.doesNotMatch(reasons.join(" "), /nothing to clear|already in default deny/);

    const alert = rendered.container.querySelector('[role="alert"]');
    assert.ok(alert, "a failed read must be announced as an alert, not a note");
    assert.match(alert.textContent ?? "", /rpc: connection reset/);
    // And the basis must not quote a stale instant as though the plan still
    // rested on it.
    assert.equal(testid(rendered.container, "incident-basis")!.querySelector("time"), null);
  } finally {
    await rendered.unmount();
  }
});

test("before the first read has landed, the freeze row is marked as not chain-derived", async () => {
  const rendered = await render(react.createElement(IncidentPanel), contextFor(null));
  try {
    const freeze = offerRows(rendered.container).find(
      (row) => row.dataset.incidentOffer === "freeze",
    );
    assert.ok(freeze, "freeze stays available pre-read, as it is on Emergency");
    assert.match(freeze.textContent ?? "", /not derived from chain state/);
    assert.match(
      testid(rendered.container, "incident-situation")!.textContent ?? "",
      /No live status read yet/,
    );
  } finally {
    await rendered.unmount();
  }
});

test("an already-frozen account is not offered a second freeze that costs a signature", async () => {
  const rendered = await render(react.createElement(IncidentPanel), contextFor(frozen));
  try {
    const ids = offerRows(rendered.container).map((row) => row.dataset.incidentOffer);
    assert.deepEqual(ids, ["unfreeze", "revoke-policy"]);
    assert.equal(refusalRows(rendered.container).length, 1);
  } finally {
    await rendered.unmount();
  }
});

// ── The hand-off focuses, it never acts ─────────────────────────────────────

test("the freeze hand-off focuses Emergency's real control and does not open its dialog", async () => {
  const ops = fakeOps([{ ok: true, value: statusValue() }]);
  const rendered = await render(
    react.createElement(IncidentPanel, { ops: ops.ops }),
    contextFor(healthy),
    true,
  );
  try {
    const target = document.querySelector<HTMLButtonElement>('[data-incident-action="freeze"]');
    assert.ok(target, "Emergency's own freeze button must be the target");
    assert.equal(target.disabled, false);
    assert.notEqual(document.activeElement, target);

    await act(async () => {
      handoffButton(rendered.container, "freeze").click();
      await sleep(10);
    });

    assert.equal(document.activeElement, target, "the hand-off must move focus, not act");
    assert.equal(
      document.querySelector('[role="dialog"]'),
      null,
      "focusing must not open the confirmation dialog — that would be the panel performing the write",
    );
    assert.equal(ops.calls.length, 0, "a hand-off reads nothing");
    const spoken = pendingAnnouncements()
      .map((a) => a.message)
      .join(" | ");
    assert.match(spoken, /Nothing was signed/);
    assert.match(spoken, /Activate it to complete the confirmation there/);
  } finally {
    await rendered.unmount();
  }
});

test("the panel signs nothing on any state it can be handed", async () => {
  const context = contextFor(frozen);
  const rendered = await render(react.createElement(IncidentPanel), context);
  try {
    for (const row of offerRows(rendered.container)) {
      const button = row.querySelector<HTMLButtonElement>("button");
      if (button !== null) {
        await act(async () => {
          button.click();
          await sleep(5);
        });
      }
    }
    assert.equal(context.signCalls.value, 0, "no path through this panel may reach for a signer");
  } finally {
    await rendered.unmount();
  }
});

test("a hand-off whose control is missing says so, offers the route, and states nothing was signed", async () => {
  const rendered = await render(react.createElement(IncidentPanel), contextFor(healthy));
  try {
    await act(async () => {
      handoffButton(rendered.container, "freeze").click();
      await sleep(10);
    });
    const missed = testid(rendered.container, "incident-handoff-missed");
    assert.ok(
      missed,
      "Emergency is not on this page; the panel must admit the hand-off went nowhere",
    );
    assert.match(missed.textContent ?? "", /collapsed|confirmation is already open/);
    assert.equal(missed.getAttribute("role"), "status");
    assert.equal(missed.querySelector("a")?.getAttribute("href"), "/panic");
    assert.match(
      pendingAnnouncements()
        .map((a) => a.message)
        .join(" | "),
      /Nothing was signed/,
    );
  } finally {
    await rendered.unmount();
  }
});

test("a hand-off to a disabled control says it is disabled rather than focusing a dead button", async () => {
  const rendered = await render(react.createElement(IncidentPanel), contextFor(healthy));
  // A control Emergency has itself disabled — looked up document-wide, which is
  // how the panel finds the real one between sibling panels.
  const standin = document.createElement("button");
  standin.dataset.incidentAction = "freeze";
  standin.disabled = true;
  document.body.appendChild(standin);
  try {
    await act(async () => {
      handoffButton(rendered.container, "freeze").click();
      await sleep(10);
    });
    const missed = testid(rendered.container, "incident-handoff-missed");
    assert.ok(missed);
    assert.match(missed.textContent ?? "", /has disabled that control/);
    assert.notEqual(document.activeElement, standin);
  } finally {
    standin.remove();
    await rendered.unmount();
  }
});

// ── What the list was decided from ──────────────────────────────────────────

test("the basis carries the instant of the read behind the list, in a machine-readable time", async () => {
  const rendered = await render(react.createElement(IncidentPanel), contextFor(healthy));
  try {
    const time = testid(rendered.container, "incident-basis")!.querySelector("time");
    assert.ok(time);
    assert.equal(time.getAttribute("dateTime"), READ_AT);
    assert.match(
      testid(rendered.container, "incident-basis")!.textContent ?? "",
      /not what your write did/,
    );
    assert.equal(
      testid(rendered.container, "incident-verification"),
      null,
      "no check until the operator asks",
    );
  } finally {
    await rendered.unmount();
  }
});

test("the actions the console will not perform are stated with where they live", async () => {
  const rendered = await render(react.createElement(IncidentPanel), contextFor(healthy));
  try {
    const elsewhere = testid(rendered.container, "incident-elsewhere")!;
    assert.match(elsewhere.textContent ?? "", /Install or adjust a policy/);
    assert.match(elsewhere.textContent ?? "", /Rotate the agent key/);
    assert.match(elsewhere.textContent ?? "", /Send a heartbeat/);
    const hrefs = Array.from(elsewhere.querySelectorAll("a")).map((a) => a.getAttribute("href"));
    assert.ok(hrefs.includes("/configure") && hrefs.includes("/deploy"));
    assert.ok(!hrefs.includes("#"), "an action with no screen gets no invented link");
  } finally {
    await rendered.unmount();
  }
});

// ── Verify on chain ─────────────────────────────────────────────────────────

test("the verification read is one status() call for this guard and it never signs", async () => {
  const ops = fakeOps([
    snapshotWith({ ok: true, value: statusValue({ admin_frozen: true }) }).status,
  ]);
  const context = contextFor(healthy);
  const rendered = await render(react.createElement(IncidentPanel, { ops: ops.ops }), context);
  try {
    await act(async () => {
      verifyButton(rendered.container).click();
      await sleep(20);
    });
    assert.deepEqual(
      ops.calls,
      [{ guard: GUARD, source: ADMIN }],
      "one read, for the guard in front of the operator",
    );
    assert.equal(context.signCalls.value, 0);
    assert.match(pill(rendered.container).textContent ?? "", /^changed$/);
    assert.match(pill(rendered.container).className, /warn/);
    assert.match(
      testid(rendered.container, "incident-verification")!.textContent ?? "",
      /admin freeze set/,
    );
    assert.match(
      testid(rendered.container, "incident-verification")!.textContent ?? "",
      new RegExp(GUARD),
    );
  } finally {
    await rendered.unmount();
  }
});

test("an agreement is reported as no change and never coloured as a success", async () => {
  const ops = fakeOps([healthy.status]);
  const rendered = await render(
    react.createElement(IncidentPanel, { ops: ops.ops }),
    contextFor(healthy),
  );
  try {
    await act(async () => {
      verifyButton(rendered.container).click();
      await sleep(20);
    });
    assert.match(pill(rendered.container).textContent ?? "", /no change/);
    assert.match(pill(rendered.container).className, /muted/);
    assert.doesNotMatch(pill(rendered.container).className, /\bok\b/);
  } finally {
    await rendered.unmount();
  }
});

test("a verification read that fails is a danger verdict naming its own error", async () => {
  const ops = fakeOps([{ ok: false, error: "rpc: timeout after 8000ms" }]);
  const rendered = await render(
    react.createElement(IncidentPanel, { ops: ops.ops }),
    contextFor(healthy),
  );
  try {
    await act(async () => {
      verifyButton(rendered.container).click();
      await sleep(20);
    });
    assert.match(pill(rendered.container).textContent ?? "", /read failed/);
    assert.match(pill(rendered.container).className, /danger/);
    const block = testid(rendered.container, "incident-verification")!;
    assert.match(block.textContent ?? "", /nothing has been confirmed either way/);
    assert.match(block.textContent ?? "", /rpc: timeout after 8000ms/);
    // Every flag is spelled as unread rather than shown with a reassuring false.
    assert.equal((block.textContent ?? "").match(/not read/g)?.length, 3);
  } finally {
    await rendered.unmount();
  }
});

test("a read that throws is reported as a failed verification rather than silently clearing the block", async () => {
  const rendered = await render(
    react.createElement(IncidentPanel, {
      ops: {
        readStatus: async () => {
          throw new Error("transport died mid-call");
        },
      } as Partial<IncidentPanelOps>,
    }),
    contextFor(healthy),
  );
  try {
    await act(async () => {
      verifyButton(rendered.container).click();
      await sleep(20);
    });
    const block = testid(rendered.container, "incident-verification");
    assert.ok(block, "a thrown read must still be reported, not swallowed");
    assert.match(block.textContent ?? "", /transport died mid-call/);
    assert.match(pill(rendered.container).className, /danger/);
  } finally {
    await rendered.unmount();
  }
});

test("a verification reply for a guard the operator has left is not shown", async () => {
  const ops = fakeOps([frozen.status]);
  const rendered = await render(
    react.createElement(IncidentPanel, { ops: ops.ops }),
    contextFor(healthy),
  );
  await act(async () => {
    verifyButton(rendered.container).click();
    await sleep(20);
  });
  const shownBeforeSwitch = testid(rendered.container, "incident-verification") !== null;
  await rendered.rerender(contextFor(healthy, { guard: OTHER }));
  const shownAfterSwitch = testid(rendered.container, "incident-verification") !== null;
  const callGuards = ops.calls.map((call) => call.guard);
  // Torn down before the assertions on purpose: this tree has been re-parented
  // onto a guard it did not start on, and leaving it mounted makes the next test
  // in the file inherit a live root.
  await rendered.unmount();

  assert.ok(shownBeforeSwitch, "the check the operator started must appear");
  assert.ok(!shownAfterSwitch, "a verdict about another account is not information about this one");
  assert.deepEqual(callGuards, [GUARD]);
});

test("demo data is labelled as a fixture and cannot be verified against a chain", async () => {
  const dom = installDom();
  dom.window.history.replaceState(null, "", "/?demo=true");
  const ops = fakeOps([healthy.status]);
  const rendered = await render(
    react.createElement(IncidentPanel, { ops: ops.ops }),
    contextFor(healthy),
  );
  try {
    assert.match(
      testid(rendered.container, "incident-demo-caveat")!.textContent ?? "",
      /fixture, not a chain read/,
    );
    const button = verifyButton(rendered.container);
    assert.equal(button.disabled, true);
    assert.match(button.getAttribute("title") ?? "", /Demo mode never reads the chain/);
    await act(async () => {
      button.click();
      await sleep(10);
    });
    assert.equal(ops.calls.length, 0, "a disabled verify button must not reach the RPC");
  } finally {
    await rendered.unmount();
    dom.window.history.replaceState(null, "", "/");
  }
});

test("the freeze row states the acknowledgement Emergency will actually ask for", async () => {
  const rendered = await render(react.createElement(IncidentPanel), contextFor(healthy));
  try {
    const row = offerRows(rendered.container).find((r) => r.dataset.incidentOffer === "freeze")!;
    assert.match(
      row.textContent ?? "",
      /Confirmation it requires: Emergency asks for an acknowledgement/,
    );
  } finally {
    await rendered.unmount();
  }
});

test("the unfreeze row says plainly that its click goes straight to the wallet", async () => {
  const rendered = await render(react.createElement(IncidentPanel), contextFor(frozen));
  try {
    const row = offerRows(rendered.container).find((r) => r.dataset.incidentOffer === "unfreeze")!;
    assert.match(
      row.textContent ?? "",
      /submits on the click — the signature prompt in your wallet is the confirmation/,
    );
  } finally {
    await rendered.unmount();
  }
});

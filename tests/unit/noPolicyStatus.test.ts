import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test, before, afterEach } from "node:test";
import type { ContextType, ReactElement } from "react";
import { installDom, loadReact, sleep, type Act } from "./domHarness.ts";
import { StatusPanel } from "../../components/StatusPanel.tsx";
import { PolicyForm } from "../../components/PolicyForm.tsx";
import { GuardContext, GuardEventsContext } from "../../components/GuardProvider.tsx";
import { NO_POLICY_CONSEQUENCE, policyStateFrom } from "../../lib/guard/policyState.ts";
import { configureHref, resolveGuardFromSearch } from "../../lib/guard/deeplink.ts";
import type { GuardSnapshot } from "../../lib/guard/guardOps.ts";
import type { GuardStatus } from "stellar-agent-guard-sdk";

installDom();

const GUARD = "CAYJZT4XH5SWDXNR7MZJCCUBIDAT2KZDDUTZ7OZQEMKCPJGD4P3X4CU7";
const ADMIN = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWH";

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
});

/** A guard whose `status()` succeeded, with the policy state under test. */
function statusWith(hasPolicy: boolean): GuardStatus {
  return {
    has_policy: hasPolicy,
    admin_frozen: false,
    heartbeat_expired: false,
    last_heartbeat: 1_700_000_000n,
    now: 1_700_000_060n,
  };
}

function snapshotWith(hasPolicy: boolean): GuardSnapshot {
  return {
    guard: GUARD,
    fetchedAt: "2026-09-25T10:00:00.000Z",
    status: { ok: true, value: statusWith(hasPolicy) },
    // A guard with no policy stored reports `policy()` as null — the same value
    // a revoke produces, which is why the two states are indistinguishable here
    // and must be presented identically.
    policy: { ok: true, value: hasPolicy ? policyFixture() : null },
    window: { ok: true, value: null },
    identity: {
      ok: true,
      value: {
        reportedWasmHash: "abc123",
        fetchedSha256: "abc123",
        bytes: 39673,
        match: true,
        source: "network",
        verifiedAt: "2026-09-25T10:00:00.000Z",
      },
    },
  };
}

function policyFixture() {
  return {
    per_tx_cap: 1_000_000n,
    window_cap: 5_000_000n,
    window_secs: 86_400n,
    assets: [],
    recipients: [],
    protocols: [],
    paused: false,
    active_from: 0n,
    active_until: 0n,
    allow_any_recipient: false,
    dms_grace_secs: 0n,
  };
}

/** A snapshot whose `status()` read failed while the transport itself did not. */
function snapshotWithFailedStatusRead(): GuardSnapshot {
  return { ...snapshotWith(false), status: { ok: false, error: "rpc: connection reset" } };
}

/**
 * A guard context that never touches the network — the snapshot is injected, and
 * only the fields the panel under test reads are supplied.
 */
function contextFor(snapshot: GuardSnapshot | null, snapshotError: string | null = null) {
  return {
    snapshot,
    snapshotError,
    guard: GUARD,
    wallet: { address: ADMIN, networkPassphrase: "p", network: "testnet" },
    refreshing: false,
    refresh: async () => {},
  };
}

/**
 * The provider's own value type, so a partial fixture can be handed to the
 * provider with a cast the reader can see (and TypeScript can check) at the one
 * place it is passed in.
 */
type GuardContextValue = NonNullable<ContextType<typeof GuardContext>>;
type TestContext = ReturnType<typeof contextFor>;

interface Rendered {
  container: HTMLElement;
  rerender: (context: TestContext) => Promise<void>;
  unmount: () => Promise<void>;
}

async function renderGuarded(panel: ReactElement, context: TestContext): Promise<Rendered> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = async (value: TestContext) => {
    await act(async () => {
      root.render(
        react.createElement(
          GuardEventsContext.Provider,
          { value: [] },
          react.createElement(GuardContext.Provider, { value: value as GuardContextValue }, panel),
        ),
      );
    });
    await act(async () => {
      await sleep(10);
    });
  };
  await render(context);
  return {
    container,
    rerender: render,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

/** The warning-tier banner, if this render has one. */
function banner(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>("[data-tier]");
}

async function withStatusPanel(
  context: TestContext,
  body: (container: HTMLElement) => void | Promise<void>,
): Promise<void> {
  const rendered = await renderGuarded(react.createElement(StatusPanel), context);
  try {
    await body(rendered.container);
  } finally {
    await rendered.unmount();
  }
}

// ── The derivation, on its own ──────────────────────────────────────────────

test("policyStateFrom is a three-state reading: unknown is neither policy nor default-deny", () => {
  assert.equal(policyStateFrom({ ok: true, value: statusWith(true) }), "installed");
  assert.equal(policyStateFrom({ ok: true, value: statusWith(false) }), "default-deny");
  // A failed read is not evidence of an empty policy, and an absent read is not
  // evidence of anything at all.
  assert.equal(policyStateFrom({ ok: false, error: "rpc down" }), "unknown");
  assert.equal(policyStateFrom(null), "unknown");
  assert.equal(policyStateFrom(undefined), "unknown");
});

test("the consequence copy names the block and the default-deny state", () => {
  assert.match(NO_POLICY_CONSEQUENCE, /ALL transactions are blocked/);
  assert.match(NO_POLICY_CONSEQUENCE, /default-deny/);
});

// ── The console's status panel ──────────────────────────────────────────────

test("no policy installed: the warning banner states the consequence and offers the configure CTA", async () => {
  await withStatusPanel(contextFor(snapshotWith(false)), (container) => {
    const shown = banner(container);
    assert.ok(shown, "the default-deny state must render a warning-tier banner");
    assert.equal(shown.getAttribute("data-tier"), "warn");
    assert.equal(shown.getAttribute("role"), "status");
    // Keyed to copy that must exist: editing the wording has to fail this test,
    // so a future copy edit is deliberate rather than accidental.
    assert.match(shown.textContent ?? "", /default-deny/);
    assert.match(shown.textContent ?? "", /ALL transactions are blocked/);

    const cta = shown.querySelector("a");
    assert.ok(cta, "the banner must carry a call to action");
    assert.equal(cta.getAttribute("href"), configureHref(GUARD));
    assert.match(cta.textContent ?? "", /Configure a policy/);
  });
});

test("a policy on chain means no default-deny banner (no false alarm)", async () => {
  await withStatusPanel(contextFor(snapshotWith(true)), (container) => {
    assert.equal(
      banner(container),
      null,
      "an installed policy must not raise the default-deny banner",
    );
    assert.doesNotMatch(container.textContent ?? "", /ALL transactions are blocked/);
  });
});

test("a failed status() read claims nothing: the read's error shows, the banner does not", async () => {
  await withStatusPanel(contextFor(snapshotWithFailedStatusRead()), (container) => {
    assert.equal(
      banner(container),
      null,
      "an unreadable status() must not be reported as a default-deny state",
    );
    assert.match(container.textContent ?? "", /status\(\): read failed/);
    assert.match(container.textContent ?? "", /rpc: connection reset/);
    // And the inline stat must not fall back to the no-policy string either.
    assert.doesNotMatch(container.textContent ?? "", /no — default deny/);
  });
});

test("no snapshot at all (the read never returned) claims nothing", async () => {
  await withStatusPanel(contextFor(null, "getEvents: fetch failed"), (container) => {
    assert.equal(banner(container), null, "an absent snapshot is not a default-deny state");
    assert.match(container.textContent ?? "", /could not be read/);
    assert.doesNotMatch(container.textContent ?? "", /no — default deny/);
  });
});

test("a revoke shows up on the next read, with no local flag to keep in step", async () => {
  // The panel holds no policy state of its own: the same component, given the
  // snapshot `refresh()` would return after an operator revoked the policy, has
  // to start warning. This is the derived-from-truth test — a local "just
  // revoked" flag could pass a click-driven test and fail this one.
  const rendered = await renderGuarded(
    react.createElement(StatusPanel),
    contextFor(snapshotWith(true)),
  );
  try {
    assert.equal(banner(rendered.container), null, "a policy is installed to begin with");
    await rendered.rerender(contextFor(snapshotWith(false)));
    assert.ok(
      banner(rendered.container),
      "the read path alone must be enough to raise the banner after a revoke",
    );
  } finally {
    await rendered.unmount();
  }
});

// ── The configure page ──────────────────────────────────────────────────────

test("the configurator shows the same banner and will not offer a revoke already in force", async () => {
  const rendered = await renderGuarded(
    react.createElement(PolicyForm),
    contextFor(snapshotWith(false)),
  );
  try {
    const shown = banner(rendered.container);
    assert.ok(shown, "the configure page must warn about the state it is about to change");
    assert.match(shown.textContent ?? "", /default-deny/);
    const cta = shown.querySelector("a");
    assert.equal(cta?.getAttribute("href"), "#install-policy");

    const revoke = buttonByText(rendered.container, "Revoke policy (default deny)");
    assert.equal(
      revoke.disabled,
      true,
      "revoking a policy that is already gone costs a signature and changes nothing",
    );
  } finally {
    await rendered.unmount();
  }
});

test("an unreadable status() leaves the revoke action alone rather than guessing", async () => {
  const rendered = await renderGuarded(
    react.createElement(PolicyForm),
    contextFor(snapshotWithFailedStatusRead()),
  );
  try {
    assert.equal(banner(rendered.container), null);
    assert.equal(
      buttonByText(rendered.container, "Revoke policy (default deny)").disabled,
      false,
      "an unknown policy state must not disable a write the operator asked for",
    );
  } finally {
    await rendered.unmount();
  }
});

// ── Routing the call to action ──────────────────────────────────────────────

test("the CTA carries the guard being looked at, and the landing page adopts it", () => {
  assert.equal(configureHref(GUARD), `/configure?guard=${GUARD}`);

  // Registry-aware: a guard already in the registry needs no new option.
  const known = resolveGuardFromSearch({
    search: configureHref(GUARD).slice("/configure".length),
    registry: [{ guard: GUARD }],
    current: "COTHERGUARDADDRESSFORTHEPREVIOUSSELECTION0000000000000",
  });
  assert.deepEqual(known, { guard: GUARD, addToRegistry: false });

  // An address the operator has never added is adopted and registered, so the
  // selector cannot end up holding a value no option matches.
  const unknown = resolveGuardFromSearch({ search: `?guard=${GUARD}`, registry: [], current: "" });
  assert.deepEqual(unknown, { guard: GUARD, addToRegistry: true });

  // Nothing to adopt: absent, malformed, or already selected.
  assert.equal(resolveGuardFromSearch({ search: "", registry: [], current: GUARD }), null);
  assert.equal(resolveGuardFromSearch({ search: "?guard=nope", registry: [], current: "" }), null);
  assert.equal(
    resolveGuardFromSearch({ search: `?guard=${GUARD}`, registry: [], current: GUARD }),
    null,
  );
});

// ── The shared tier ─────────────────────────────────────────────────────────

test("the warning banner reuses the shared notice tier the stylesheet defines", () => {
  const css = readFileSync("app/globals.css", "utf8");
  assert.match(css, /\.notice\s*\{[^}]*border-left:\s*3px solid var\(--warn\)/);
  assert.match(css, /\.notice\.danger\s*\{[^}]*var\(--danger\)/);
  assert.match(css, /\.notice\.info\s*\{/);
  // Printing the compliance report must not turn the banner into black text on
  // a black box, so the tier needs a print treatment.
  assert.match(css, /@media print[\s\S]*\.notice,\s*\.notice\.danger,\s*\.notice\.info\s*\{/);
});

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  assert.ok(button, `expected a button labelled "${text}"`);
  return button;
}

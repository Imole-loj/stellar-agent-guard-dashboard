/**
 * The stale-read race, applied to every async surface (issue #40).
 *
 * `tests/unit/guardSwitch.test.ts` pinned the race for one surface (`status`).
 * This suite generalises it: status, policy, the rolling window and the wasm
 * identity are read together by `readGuardSnapshot`, and each one has the same
 * obligation — a response that belongs to an identity the operator has left
 * must never be painted. The test helper in `tests/helpers/identityRace.ts`
 * holds each read open per contract address, so the interleaving is exact and
 * the tests are deterministic (no sleeps to win a race).
 *
 * The network axis is covered with the same helper: `GuardProvider` treats a
 * change of RPC server as a context change, so two servers stand in for two
 * networks until the registry/network selector lands. The identity key the
 * production guard uses is the same monotonic read epoch in both cases — this
 * suite exercises that one mechanism, not a test-only reimplementation.
 */

import assert from "node:assert/strict";
import { afterEach, before, test } from "node:test";
import type { ReactElement, ReactNode } from "react";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { installDom, loadReact, sleep, type Act } from "./domHarness.ts";
import { GuardProvider, useGuard } from "../../components/GuardProvider.tsx";
import { KNOWN_INSTANCES } from "../../lib/guard/instance.ts";
import {
  createRaceServer,
  type RaceServer,
  type RaceValues,
  type Surface,
} from "../helpers/identityRace.ts";

installDom();
// Force the storage fallback transport so no real BroadcastChannel is left open
// by the test process.
(globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = undefined;

const G0 = KNOWN_INSTANCES[0]!.guard;
const GUARD_A = "CBLQLJAG72M4XQRJMQHSKYIFVHQD7LNTNOQH2GRMCMBWMSLBSLTGTJC7";
const GUARD_B = "CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB";

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
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
});

/** The probe's text for a surface, derived only from the provider's snapshot. */
function surfaceText(surface: Surface, snapshot: ReturnType<typeof useGuard>["snapshot"]): string {
  switch (surface) {
    case "status": {
      if (!snapshot?.status.ok) return "STATUS:ERROR";
      return snapshot.status.value.admin_frozen ? "FROZEN" : "CLEAR";
    }
    case "policy": {
      if (!snapshot?.policy.ok) return "POLICY:ERROR";
      const policy = snapshot.policy.value;
      return policy === null ? "POLICY:NONE" : `POLICY:${policy.per_tx_cap}`;
    }
    case "window": {
      if (!snapshot?.window.ok) return "WINDOW:ERROR";
      const window = snapshot.window.value;
      return window === null ? "WINDOW:NONE" : `WINDOW:${window.total}`;
    }
    case "identity": {
      if (!snapshot?.identity.ok) return "IDENTITY:ERROR";
      return `IDENTITY:${snapshot.identity.value.bytes}`;
    }
  }
}

/** The value each surface renders when the *old* identity's read lands late. */
const OLD_VALUES: Record<Surface, Partial<RaceValues>> = {
  status: { adminFrozen: true },
  policy: { policyCap: 100n },
  window: { windowTotal: 1_000n },
  identity: { identityBytes: 101 },
};

/** The value each surface renders once the *new* identity's read lands. */
const NEW_VALUES: Record<Surface, Partial<RaceValues>> = {
  status: { adminFrozen: false },
  policy: { policyCap: 200n },
  window: { windowTotal: 2_000n },
  identity: { identityBytes: 202 },
};

const EXPECTED_NEW: Record<Surface, string> = {
  status: "CLEAR",
  policy: "POLICY:200",
  window: "WINDOW:2000",
  identity: "IDENTITY:202",
};

const EXPECTED_OLD: Record<Surface, string> = {
  status: "FROZEN",
  policy: "POLICY:100",
  window: "WINDOW:1000",
  identity: "IDENTITY:101",
};

function Probe({ guards = [] }: { guards?: string[] }): ReactElement {
  const { guard, snapshot, selectGuard, refresh } = useGuard();
  return react.createElement(
    "div",
    null,
    react.createElement("span", { "data-testid": "guard" }, guard),
    ...(["status", "policy", "window", "identity"] as const).map((surface) =>
      react.createElement(
        "span",
        { key: surface, "data-testid": surface },
        surfaceText(surface, snapshot),
      ),
    ),
    react.createElement(
      "button",
      { "data-testid": "refresh", onClick: () => void refresh() },
      "refresh",
    ),
    ...guards.map((target, index) =>
      react.createElement(
        "button",
        { key: target, "data-testid": `select-${index}`, onClick: () => selectGuard(target) },
        `select ${index}`,
      ),
    ),
  );
}

function text(container: HTMLElement, testid: string): string {
  return container.querySelector(`[data-testid="${testid}"]`)?.textContent ?? "";
}

interface Rendered {
  container: HTMLElement;
  rerender: (node: ReactNode) => Promise<void>;
  unmount: () => Promise<void>;
}

async function render(node: ReactNode): Promise<Rendered> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: ReturnType<typeof createRoot> | undefined;
  const wrap = (child: ReactNode): ReactElement =>
    react.createElement(
      AppRouterContext.Provider,
      {
        value: {
          back: () => {},
          forward: () => {},
          refresh: () => {},
          hmrRefresh: () => {},
          push: () => {},
          replace: () => {},
          prefetch: async () => {},
        } as never,
      },
      react.createElement(PathnameContext.Provider, { value: "/" }, child),
    );
  await act(async () => {
    root = createRoot(container);
    root.render(wrap(node));
  });
  return {
    container,
    rerender: async (child) => {
      await act(async () => {
        root?.render(wrap(child));
      });
    },
    unmount: async () => {
      await act(async () => {
        root?.unmount();
      });
      container.remove();
    },
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    await sleep(30);
  });
}

async function click(container: HTMLElement, testid: string): Promise<void> {
  await act(async () => {
    container.querySelector<HTMLButtonElement>(`[data-testid="${testid}"]`)!.click();
  });
}

/**
 * Mount the provider on guard A, switch to B with A's target read still in
 * flight, then resolve A late. Returns the server for call-count assertions.
 */
async function runSwitch(surface: Surface): Promise<RaceServer> {
  const fake = createRaceServer();
  const rendered = await render(
    react.createElement(GuardProvider, {
      server: fake.server,
      children: react.createElement(Probe, { guards: [GUARD_A, GUARD_B] }),
    }),
  );
  try {
    // Settle the initial (build-seeded) guard so the page has a real baseline.
    await settle();
    fake.resolveAll(G0);
    await settle();
    assert.equal(text(rendered.container, "guard"), G0);

    // Switch to A; leave A's target surface in flight.
    await click(rendered.container, "select-0");
    await settle();
    assert.equal(text(rendered.container, "guard"), GUARD_A);
    assert.equal(fake.pendingFor(GUARD_A, surface), 1, "A's target read is in flight");
    fake.resolveAll(GUARD_A, { skip: surface });
    await settle();

    // Switch to B before A resolves, and let B paint.
    await click(rendered.container, "select-1");
    await settle();
    assert.equal(text(rendered.container, "guard"), GUARD_B);
    fake.resolveAll(GUARD_B, { values: NEW_VALUES[surface] });
    await settle();
    assert.equal(text(rendered.container, surface), EXPECTED_NEW[surface], "B's value is painted");

    // The older read (A) now resolves. It must be dropped, not merged.
    fake.resolveSurface(GUARD_A, surface, OLD_VALUES[surface]);
    await settle();
    assert.equal(text(rendered.container, "guard"), GUARD_B, "still on B");
    assert.equal(
      text(rendered.container, surface),
      EXPECTED_NEW[surface],
      "A's late value never paints over B",
    );
    assert.equal(
      text(rendered.container, surface).includes(EXPECTED_OLD[surface]),
      false,
      "the old identity's value is absent",
    );

    // Both identities really were read: the guard is not passing by skipping
    // the new read or by reusing the old one.
    assert.ok(fake.callsFor(GUARD_A, surface) >= 1, "A's read started");
    assert.ok(fake.callsFor(GUARD_B, surface) >= 1, "B's read started");
    return fake;
  } finally {
    await rendered.unmount();
    fake.release();
  }
}

for (const surface of ["status", "policy", "window", "identity"] as const) {
  test(`identity switch: a late ${surface} read never paints over the new guard`, async () => {
    await runSwitch(surface);
  });
}

test("network switch: an in-flight read from the previous server is discarded", async () => {
  const first = createRaceServer();
  const second = createRaceServer();
  const tree = (server: RaceServer): ReactElement =>
    react.createElement(GuardProvider, {
      server: server.server,
      children: react.createElement(Probe),
    });

  const rendered = await render(tree(first));
  try {
    await settle();
    first.resolveAll(G0);
    await settle();
    assert.equal(text(rendered.container, "status"), "CLEAR");

    // Start a second full read on the current server and leave it in flight.
    await click(rendered.container, "refresh");
    await settle();
    assert.equal(first.pendingFor(G0, "status"), 1, "the old server's status read is in flight");

    // The network (RPC server) changes. That is a new identity context even
    // though the guard address is the same.
    await rendered.rerender(tree(second));
    await settle();
    second.resolveAll(G0);
    await settle();
    assert.equal(text(rendered.container, "status"), "CLEAR");

    // The old network's response lands late and says FROZEN. It belongs to a
    // network the operator has left.
    first.resolveSurface(G0, "status", { adminFrozen: true });
    await settle();
    assert.equal(text(rendered.container, "status"), "CLEAR", "the old network never paints");
    assert.ok(second.callsFor(G0, "status") >= 1, "the new server was read");
  } finally {
    await rendered.unmount();
    first.release();
    second.release();
  }
});

/**
 * The deploy panel's verification provenance, rendered (issue #290).
 *
 * The pure view model and the gate are unit-tested in
 * `artifactProvenance.test.ts`; what only a rendered panel can show is that the
 * `ArtifactCheck` actually reaches the operator — the byte source, the exact
 * length, the instance that was read and when — and that a second mount reuses
 * the stored verification *while still reading the ledger live*, which is the
 * line between "cached bytes" and "cached authority".
 */

import assert from "node:assert/strict";
import { afterEach, before, test } from "node:test";
import type { ContextType, ReactElement } from "react";
import { installDom, loadReact, sleep, type Act } from "./domHarness.ts";
import { DeployPanel } from "../../components/DeployPanel.tsx";
import { GuardContext, GuardEventsContext } from "../../components/GuardProvider.tsx";
import { PHASE1_ARTIFACT } from "../../lib/guard/network.ts";
import { sha256Hex } from "../../lib/guard/scval.ts";

// The bytecode cache prefers `sessionStorage`; jsdom's is not a global here, so
// the test installs a plain in-memory one — the same store the browser uses,
// minus the browser.
const backing = new Map<string, string>();
Object.defineProperty(globalThis, "sessionStorage", {
  configurable: true,
  value: {
    getItem: (key: string): string | null => backing.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      backing.set(key, value);
    },
    removeItem: (key: string): void => {
      backing.delete(key);
    },
    clear: (): void => {
      backing.clear();
    },
  },
});

installDom();

const ADMIN = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWH";
const WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x2a]);

let react: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let act: Act;
let wasmHashHex: string;

before(async () => {
  const loaded = await loadReact();
  react = loaded.react;
  createRoot = loaded.createRoot;
  act = loaded.act;
  wasmHashHex = await sha256Hex(WASM);
});

afterEach(() => {
  document.body.innerHTML = "";
  backing.clear();
});

/**
 * A chain that serves one instance and its bytecode.
 *
 * Every other method rejects, exactly like the no-network server the a11y
 * audit renders with, so the panel's other reads settle into their error states
 * without a packet leaving the process.
 */
function chain() {
  const counts = { instance: 0, wasm: 0 };
  const server = new Proxy(
    {},
    {
      get: (_target, property) => {
        if (property === "serverURL") return new URL("https://soroban-testnet.stellar.org");
        if (property === "getContractInstance") {
          return async () => {
            counts.instance += 1;
            return { executable: { wasmHash: new Uint8Array(Buffer.from(wasmHashHex, "hex")) } };
          };
        }
        if (property === "getContractWasmByContractId") {
          return async () => {
            counts.wasm += 1;
            return WASM;
          };
        }
        return () => Promise.reject(new Error("network disabled in unit tests"));
      },
    },
  );
  return { counts, server };
}

type GuardContextValue = NonNullable<ContextType<typeof GuardContext>>;

function contextFor(server: unknown) {
  // The same shape the a11y audit renders every panel with: a context whose
  // reads all fail is enough for the artifact stats, and the panels tolerate it.
  return {
    server,
    wallet: { address: ADMIN, networkPassphrase: "p", network: "testnet" },
    walletError: null,
    connecting: false,
    connect: async () => {},
    disconnect: () => {},
    signer: () => {
      throw new Error("nothing may be signed in these tests");
    },
    instances: [],
    guard: PHASE1_ARTIFACT.guard,
    selectGuard: () => {},
    addInstance: () => {},
    snapshot: null,
    snapshotError: null,
    refreshing: false,
    refresh: async () => {},
    feed: {
      watching: false,
      latestLedger: null,
      error: null,
      lastPolledAt: null,
      guards: [],
      capped: 0,
      cappedLabels: [],
      health: { state: "off" },
      gaps: [],
    },
    startWatching: () => {},
    stopWatching: () => {},
    tailSelection: [],
    toggleTailedGuard: () => {},
    exportRange: null,
    stream: { paused: false, pendingCount: 0, dropped: 0 },
    pauseStream: () => {},
    resumeStream: () => {},
    clearEvents: () => {},
    pushEvents: () => {},
    queryRange: async () => {},
    rangeLabel: null,
    notifyTabs: () => {},
  } as unknown as GuardContextValue;
}

async function renderPanel(server: unknown) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      react.createElement(
        GuardEventsContext.Provider,
        { value: [] },
        react.createElement(
          GuardContext.Provider,
          { value: contextFor(server) },
          react.createElement(DeployPanel) as ReactElement,
        ),
      ),
    );
  });
  await act(async () => {
    await sleep(20);
  });
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
    },
  };
}

const stat = (container: HTMLElement, label: string) => {
  const found = Array.from(container.querySelectorAll<HTMLElement>(".stat")).find((node) =>
    node.querySelector(".k")?.textContent?.includes(label),
  );
  assert.ok(found, `expected a "${label}" stat`);
  return found;
};

test("the panel shows where the verified bytes came from and when they were read", async () => {
  const { counts, server } = chain();
  const panel = await renderPanel(server);
  try {
    const fetched = stat(panel.container, "Fetched from chain");
    assert.match(fetched.querySelector(".v")?.textContent ?? "", /^[0-9a-f]{16}\.\.\.$/);
    assert.equal(
      fetched.querySelector(".n")?.textContent,
      `${WASM.length} bytes, SHA-256`,
      "the exact byte length is part of the review state",
    );

    const verification = stat(panel.container, "Verification");
    assert.equal(verification.querySelector(".v")?.textContent, "network read");
    assert.match(
      verification.querySelector(".n")?.textContent ?? "",
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC$/,
    );

    const source = stat(panel.container, "Source instance");
    assert.equal(source.querySelector(".v")?.getAttribute("title"), PHASE1_ARTIFACT.guard);
    assert.equal(
      source.querySelector(".v")?.textContent,
      `${PHASE1_ARTIFACT.guard.slice(0, 6)}…${PHASE1_ARTIFACT.guard.slice(-4)}`,
    );

    assert.equal(counts.wasm, 1, "the first read fetched the bytecode");
  } finally {
    await panel.unmount();
  }
});

test("a remount reports cached bytes as a cache hit, but still reads the ledger", async () => {
  const { counts, server } = chain();
  const first = await renderPanel(server);
  const instanceReadsAfterFirst = counts.instance;
  await first.unmount();

  const second = await renderPanel(server);
  try {
    const verification = stat(second.container, "Verification");
    assert.equal(
      verification.querySelector(".v")?.textContent,
      "cache hit",
      "a stored verification is never presented as a fresh read",
    );
    assert.equal(counts.wasm, 1, "the cached bytes were not downloaded again");
    assert.equal(
      counts.instance,
      instanceReadsAfterFirst + 1,
      "the ledger's declared hash was still read live: cached bytes are not cached authority",
    );
  } finally {
    await second.unmount();
  }
});

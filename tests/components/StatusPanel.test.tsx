import assert from "node:assert/strict";
import { test, before, afterEach, describe } from "node:test";
import { installDom, loadReact } from "../unit/domHarness.ts";
import { StatusPanel } from "../../components/StatusPanel.tsx";
import type { GuardSnapshot } from "../../lib/guard/guardOps.ts";
import { GuardContext, type GuardContextValue } from "../../components/GuardProvider.tsx";

describe("StatusPanel", () => {
  let dom: ReturnType<typeof installDom>;
  let React: Awaited<ReturnType<typeof loadReact>>["react"];
  let createRoot: Awaited<ReturnType<typeof loadReact>>["createRoot"];
  let act: Awaited<ReturnType<typeof loadReact>>["act"];
  let root: ReturnType<typeof createRoot> | null = null;

  // Mock localStorage for density store
  const localStorageMock = (() => {
    let store: Record<string, string> = {};
    return {
      getItem: (key: string): string | null => store[key] ?? null,
      setItem: (key: string, value: string) => {
        store[key] = value;
      },
      removeItem: (key: string) => {
        delete store[key];
      },
      clear: () => {
        store = {};
      },
    };
  })();

  before(async () => {
    dom = installDom();
    // Mock localStorage
    Object.defineProperty(window, "localStorage", { value: localStorageMock, writable: true });
    const reactDeps = await loadReact();
    React = reactDeps.react;
    createRoot = reactDeps.createRoot;
    act = reactDeps.act;
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root!.unmount();
      });
      root = null;
    }
    document.body.innerHTML = "";
    localStorageMock.clear();
  });

  // Mock data for different status states
  const mockSnapshotActive: GuardSnapshot = {
    guard: "C123",
    fetchedAt: new Date().toISOString(),
    status: {
      ok: true,
      value: {
        admin_frozen: false,
        heartbeat_expired: false,
        has_policy: true,
        last_heartbeat: 1000n,
        now: 2000n, // Added now field for deadManRemaining calculation
      },
    },
    policy: {
      ok: true,
      value: {
        window_cap: 5000n,
        window_secs: 3600n,
        per_tx_cap: 1000n,
        assets: [],
        recipients: [],
        protocols: [],
        allow_any_recipient: false,
        paused: false,
        active_from: 0n,
        active_until: 0n,
        dms_grace_secs: 300n, // Added dead man switch grace period
      },
    },
    window: {
      ok: true,
      value: {
        total: 1000n,
        entries: [],
      },
    },
    identity: {
      ok: true,
      value: {
        match: true,
        reportedWasmHash: "abc123",
        fetchedSha256: "def456",
        bytes: 12345,
        source: "network",
        verifiedAt: "2026-09-25T10:00:00.000Z",
      },
    },
  };

  const mockSnapshotFrozen: GuardSnapshot = {
    guard: "C123",
    fetchedAt: new Date().toISOString(),
    status: {
      ok: true,
      value: {
        admin_frozen: true,
        heartbeat_expired: false,
        has_policy: true,
        last_heartbeat: 1000n,
        now: 2000n,
      },
    },
    policy: {
      ok: true,
      value: {
        window_cap: 5000n,
        window_secs: 3600n,
        per_tx_cap: 1000n,
        assets: [],
        recipients: [],
        protocols: [],
        allow_any_recipient: false,
        paused: false,
        active_from: 0n,
        active_until: 0n,
        dms_grace_secs: 300n,
      },
    },
    window: {
      ok: true,
      value: {
        total: 1000n,
        entries: [],
      },
    },
    identity: {
      ok: true,
      value: {
        match: true,
        reportedWasmHash: "abc123",
        fetchedSha256: "def456",
        bytes: 12345,
        source: "network",
        verifiedAt: "2026-09-25T10:00:00.000Z",
      },
    },
  };

  const mockSnapshotExpired: GuardSnapshot = {
    guard: "C123",
    fetchedAt: new Date().toISOString(),
    status: {
      ok: true,
      value: {
        admin_frozen: false,
        heartbeat_expired: true,
        has_policy: true,
        last_heartbeat: 1000n,
        now: 1500n, // Now is less than last_heartbeat + grace, so expired
      },
    },
    policy: {
      ok: true,
      value: {
        window_cap: 5000n,
        window_secs: 3600n,
        per_tx_cap: 1000n,
        assets: [],
        recipients: [],
        protocols: [],
        allow_any_recipient: false,
        paused: false,
        active_from: 0n,
        active_until: 0n,
        dms_grace_secs: 300n,
      },
    },
    window: {
      ok: true,
      value: {
        total: 1000n,
        entries: [],
      },
    },
    identity: {
      ok: true,
      value: {
        match: true,
        reportedWasmHash: "abc123",
        fetchedSha256: "def456",
        bytes: 12345,
        source: "network",
        verifiedAt: "2026-09-25T10:00:00.000Z",
      },
    },
  };

  const mockSnapshotNoPolicy: GuardSnapshot = {
    guard: "C123",
    fetchedAt: new Date().toISOString(),
    status: {
      ok: true,
      value: {
        admin_frozen: false,
        heartbeat_expired: false,
        has_policy: false,
        last_heartbeat: 1000n,
        now: 2000n,
      },
    },
    policy: {
      ok: false,
      error: "Policy not found",
    },
    window: {
      ok: true,
      value: {
        total: 0n,
        entries: [],
      },
    },
    identity: {
      ok: true,
      value: {
        match: true,
        reportedWasmHash: "abc123",
        fetchedSha256: "def456",
        bytes: 12345,
        source: "network",
        verifiedAt: "2026-09-25T10:00:00.000Z",
      },
    },
  };

  function createMockGuardContextValue(overrides: Partial<any> = {}): any {
    const defaults: any = {
      server: {} as any,
      wallet: { address: "GBTEST...", networkPassphrase: "Testnet", network: "Testnet" },
      walletError: null,
      connecting: false,
      connect: async () => {},
      disconnect: () => {},
      signer: () => ({
        sign: async () => ({}),
      }),
      instances: [],
      guard: "test_guard",
      selectGuard: () => {},
      addInstance: () => {},
      snapshot: mockSnapshotActive,
      snapshotError: null,
      refreshing: false,
      refresh: async () => {},
      events: [],
      feed: {
        watching: false,
        latestLedger: null,
        error: null,
        lastPolledAt: null,
      },
      startWatching: () => {},
      stopWatching: () => {},
      clearEvents: () => {},
      pushEvents: () => {},
      notifyTabs: () => {},
      session: {
        state: "idle" as const,
        timeoutMs: 0,
        setTimeoutMs: () => {},
        stayConnected: () => {},
      },
    };
    return { ...defaults, ...overrides };
  }

  test("renders Active state correctly", async () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    root = createRoot(div);

    const mockValue = createMockGuardContextValue({
      snapshot: mockSnapshotActive,
    });

    await act(() => {
      root!.render(
        React.createElement(
          GuardContext.Provider,
          { value: mockValue },
          React.createElement(StatusPanel),
        ),
      );
    });

    // Check that it renders Active state indicators
    assert.dom(document.body).containsText("On-chain state");
    assert.dom(document.body).containsText("Admin freeze");
    assert.dom(document.body).containsText("clear");
    assert.dom(document.body).containsText("Dead-man switch");
    assert.dom(document.body).containsText("within grace");
    assert.dom(document.body).containsText("Policy installed");
    assert.dom(document.body).containsText("yes");
  });

  test("renders Frozen state correctly", async () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    root = createRoot(div);

    const mockValue = createMockGuardContextValue({
      snapshot: mockSnapshotFrozen,
    });

    await act(() => {
      root!.render(
        React.createElement(
          GuardContext.Provider,
          { value: mockValue },
          React.createElement(StatusPanel),
        ),
      );
    });

    // Check that it renders Frozen state indicators
    assert.dom(document.body).containsText("Admin freeze");
    assert.dom(document.body).containsText("FROZEN");
  });

  test("renders Expired state correctly", async () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    root = createRoot(div);

    const mockValue = createMockGuardContextValue({
      snapshot: mockSnapshotExpired,
    });

    await act(() => {
      root!.render(
        React.createElement(
          GuardContext.Provider,
          { value: mockValue },
          React.createElement(StatusPanel),
        ),
      );
    });

    // Check that it renders Expired state indicators
    assert.dom(document.body).containsText("Dead-man switch");
    assert.dom(document.body).containsText("FIRED");
  });

  test("renders No Policy state correctly", async () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    root = createRoot(div);

    const mockValue = createMockGuardContextValue({
      snapshot: mockSnapshotNoPolicy,
    });

    await act(() => {
      root!.render(
        React.createElement(
          GuardContext.Provider,
          { value: mockValue },
          React.createElement(StatusPanel),
        ),
      );
    });

    // Check that it renders No Policy state indicators
    assert.dom(document.body).containsText("Policy installed");
    assert.dom(document.body).containsText("no — default deny");
  });

  test("handles loading state", async () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    root = createRoot(div);

    const mockValue = createMockGuardContextValue({
      snapshot: null,
      snapshotError: null,
      refreshing: true,
    });

    await act(() => {
      root!.render(
        React.createElement(
          GuardContext.Provider,
          { value: mockValue },
          React.createElement(StatusPanel),
        ),
      );
    });

    // Check that it shows loading state
    assert.dom(document.body).containsText("Reading the chain…");
  });

  test("handles error state", async () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    root = createRoot(div);

    const mockValue = createMockGuardContextValue({
      snapshot: null,
      snapshotError: "Failed to read from chain",
      refreshing: false,
    });

    await act(() => {
      root!.render(
        React.createElement(
          GuardContext.Provider,
          { value: mockValue },
          React.createElement(StatusPanel),
        ),
      );
    });

    // Check that it shows error state
    assert.dom(document.body).containsText("The guard's state could not be read");
  });
});

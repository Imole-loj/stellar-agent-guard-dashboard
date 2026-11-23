import assert from "node:assert/strict";
import { test, before, afterEach, describe } from "node:test";
import { installDom, loadReact } from "../unit/domHarness.ts";
import { TelemetryFeed } from "../../components/TelemetryFeed.tsx";
import type { GuardEvent } from "stellar-agent-guard-sdk";
import {
  GuardContext,
  GuardEventsContext,
  type GuardContextValue,
} from "../../components/GuardProvider.tsx";

describe("TelemetryFeed", () => {
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

  function createMockGuardContextValue(overrides: Partial<any> = {}): any {
    const defaults: any = {
      server: {} as any,
      guard: "test_guard",
      stream: { paused: false, pendingCount: 0 },
      // The declared feed shape, in full: `TelemetryAlerts` reads
      // `feed.guards` to scope its alert dedupe (#313), and a mock that omits
      // it would crash the panel rather than describe a feed that has not
      // started tailing.
      feed: {
        watching: false,
        latestLedger: null,
        error: null,
        lastPolledAt: null,
        guards: [],
        capped: 0,
        cappedLabels: [],
      },
      startWatching: () => {},
      stopWatching: () => {},
      pauseStream: () => {},
      resumeStream: () => {},
      clearEvents: () => {},
      pushEvents: () => {},
    };
    return {
      ...defaults,
      ...overrides,
      feed: { ...defaults.feed, ...(overrides.feed ?? {}) },
    };
  }

  function renderFeed(mockValue: any) {
    return React.createElement(
      GuardContext.Provider,
      { value: mockValue },
      React.createElement(
        GuardEventsContext.Provider,
        { value: mockValue.events || [] },
        React.createElement(TelemetryFeed),
      ),
    );
  }

  test("renders initial state with no events", async () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    root = createRoot(div);

    const mockValue = createMockGuardContextValue({
      events: [],
      feed: {
        watching: false,
        latestLedger: null,
        error: null,
        lastPolledAt: null,
      },
    });

    await act(() => {
      root!.render(renderFeed(mockValue));
    });

    // Check that it renders correctly
    assert.dom(document.body).containsText("Telemetry");
    assert.dom(document.body).containsText("Start watching");
    assert.dom(document.body).containsText("Clear");
    assert.dom(document.body).containsText("Start watching to tail this guard's events.");
    assert.dom(document.body).doesNotContainText("Stop"); // Should not show stop button when not watching
  });

  test("renders watching state", async () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    root = createRoot(div);

    const mockValue = createMockGuardContextValue({
      events: [],
      feed: {
        watching: true,
        latestLedger: 123456,
        error: null,
        lastPolledAt: new Date().toISOString(),
      },
    });

    await act(() => {
      root!.render(renderFeed(mockValue));
    });

    // Check that it renders watching state
    assert.dom(document.body).containsText("Telemetry");
    assert.dom(document.body).containsText("Stop"); // Should show stop button when watching
    assert.dom(document.body).doesNotContainText("Start watching"); // Should not show start button when watching
    assert.dom(document.body).containsText("ledger 123456");
    assert.dom(document.body).containsText("Last poll");
  });

  test("renders events table with data", async () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    root = createRoot(div);

    // Mock guard events
    const mockEvents: GuardEvent[] = [
      {
        id: "ledger:abc123:event_heartbeat",
        kind: "heartbeat",
        topic: "heartbeat",
        source: "ledger",
        stream: "committed",
        observedAt: null,
        transactionHash: "abc123",
        ledger: 100000,
        contractId: "C123",
        ledgerClosedAt: "2026-01-01T00:00:00Z",
        decision: {
          result: "allowed",
          reason: null,
          source: "ledger",
        },
        data: {},
      },
      {
        id: "ledger:def456:event_frozen",
        kind: "frozen",
        topic: "frozen",
        source: "ledger",
        stream: "committed",
        observedAt: null,
        contractId: "C123",
        ledgerClosedAt: "2026-01-01T00:00:00Z",
        transactionHash: "def456",
        ledger: 100001,
        decision: {
          result: "blocked",
          reason: "unauthorized",
          source: "diagnostic",
        },
        data: {},
      },
    ];

    const mockValue = createMockGuardContextValue({
      events: mockEvents,
      feed: {
        watching: true,
        latestLedger: 100001,
        error: null,
        lastPolledAt: new Date().toISOString(),
      },
    });

    await act(() => {
      root!.render(renderFeed(mockValue));
    });

    // Check that it renders events table
    assert.dom(document.body).containsText("Telemetry");
    assert.dom(document.body).containsText("Authorization decision");
    assert.dom(document.body).containsText("Agent heartbeat");
    assert.dom(document.body).containsText("Admin freeze");
    assert.dom(document.body).containsText("Allowed");
    assert.dom(document.body).containsText("Blocked");
    assert.dom(document.body).containsText("ledger");
    assert.dom(document.body).containsText("100000");
    assert.dom(document.body).containsText("100001");
    assert.dom(document.body).containsText("Transaction");
    assert.dom(document.body).containsText("Source");
    // Note: Diagnostic source would show as "diagnostic" but we're not testing the exact styling
  });

  test("shows clear button when events exist", async () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    root = createRoot(div);

    // Mock guard events
    const mockEvents: GuardEvent[] = [
      {
        id: "ledger:abc123:event_heartbeat",
        kind: "heartbeat",
        topic: "heartbeat",
        source: "ledger",
        stream: "committed",
        observedAt: null,
        transactionHash: "abc123",
        ledger: 100000,
        contractId: "C123",
        ledgerClosedAt: "2026-01-01T00:00:00Z",
        decision: {
          result: "allowed",
          reason: null,
          source: "ledger",
        },
        data: {},
      },
    ];

    const mockValue = createMockGuardContextValue({
      events: mockEvents,
      feed: {
        watching: false,
        latestLedger: 100000,
        error: null,
        lastPolledAt: null,
      },
    });

    await act(() => {
      root!.render(renderFeed(mockValue));
    });

    // Check that clear button exists and is enabled
    const clearButton = Array.from(document.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Clear"),
    ) as HTMLButtonElement | undefined;
    assert.ok(clearButton, "Clear button should exist");
    assert.strictEqual(
      clearButton?.disabled,
      false,
      "Clear button should be enabled when events exist",
    );
  });

  test("hides clear button when no events", async () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    root = createRoot(div);

    const mockValue = createMockGuardContextValue({
      events: [],
      feed: {
        watching: false,
        latestLedger: null,
        error: null,
        lastPolledAt: null,
      },
    });

    await act(() => {
      root!.render(renderFeed(mockValue));
    });

    // Check that clear button exists but is disabled
    const clearButton = Array.from(document.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Clear"),
    ) as HTMLButtonElement | undefined;
    assert.ok(clearButton, "Clear button should exist");
    assert.strictEqual(
      clearButton?.disabled,
      true,
      "Clear button should be disabled when no events exist",
    );
  });

  test("shows error state", async () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    root = createRoot(div);

    const mockValue = createMockGuardContextValue({
      events: [],
      feed: {
        watching: false,
        latestLedger: null,
        error: "Failed to connect to RPC",
        lastPolledAt: null,
      },
    });

    await act(() => {
      root!.render(renderFeed(mockValue));
    });

    // Check that it shows error state
    assert.dom(document.body).containsText("Telemetry");
    assert.dom(document.body).containsText("The event feed could not poll");
    assert.dom(document.body).containsText("Failed to connect to RPC");
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RpcPool } from "../../lib/guard/rpcPool.ts";
import {
  GuardFeedCoordinator,
  type PolledFeed,
  type TelemetryPage,
} from "../../lib/guard/telemetry.ts";

// Scripted feed double for testing endpoint cursor isolation
class ScriptedEndpointFeed implements PolledFeed {
  readonly guard: string;
  readonly endpoint: string;
  cursor: string | null = null;
  pollCount = 0;
  eventsEmitted: string[] = [];

  constructor(guard: string, endpoint: string) {
    this.guard = guard;
    this.endpoint = endpoint;
  }

  async pollOnce(): Promise<TelemetryPage> {
    this.pollCount += 1;
    if (this.cursor !== null) {
      // Stream caught up with existing cursor
      return {
        events: [],
        cursor: this.cursor,
        latestLedger: 100,
        oldestLedger: 90,
      };
    }

    // Fresh poll without cursor: receives this endpoint's native events and advances cursor
    const newCursor = `${this.endpoint}-cursor-${this.pollCount}`;
    this.cursor = newCursor;
    const eventName = `event-from-${this.endpoint}`;
    this.eventsEmitted.push(eventName);

    return {
      events: [eventName as any],
      cursor: newCursor,
      latestLedger: 100,
      oldestLedger: 90,
    };
  }

  position() {
    return { cursor: this.cursor, latestLedger: 100 };
  }

  resetFrom(_ledger: number | null): void {
    this.cursor = null;
  }
}

describe("Issue #505 - RPC endpoint cursor reset and network isolation", () => {
  it("RpcPool maintains endpoint-scoped cursors and resets them on failover", () => {
    const pool = new RpcPool("https://rpc-primary.stellar.org", [
      "https://rpc-fallback.stellar.org",
    ]);

    // Set cursor on primary
    pool.setCursor("primary-cursor-001");
    assert.equal(pool.getCursor(), "primary-cursor-001");

    // Failover occurs (3 failures)
    (pool as any).failover();

    // Active endpoint is now fallback
    assert.equal(pool.currentUrl, "https://rpc-fallback.stellar.org");
    // Cursor on fallback must be null (reset), NOT primary's cursor
    assert.equal(pool.getCursor(), null, "Fallback endpoint must not inherit primary cursor");
  });

  it("RpcPool switchEndpoint resets cursors by default and notifies listeners", () => {
    const pool = new RpcPool("https://rpc-1.test", ["https://rpc-2.test"]);
    pool.setCursor("cursor-123", "https://rpc-1.test");

    let notifiedNew: string | null = null;
    let notifiedOld: string | null = null;
    pool.onEndpointChange((newUrl, oldUrl) => {
      notifiedNew = newUrl;
      notifiedOld = oldUrl;
    });

    pool.switchEndpoint("https://rpc-custom.test");

    assert.equal(pool.currentUrl, "https://rpc-custom.test");
    assert.equal(notifiedNew, "https://rpc-custom.test");
    assert.equal(notifiedOld, "https://rpc-1.test");
    assert.equal(pool.getCursor(), null, "New endpoint cursor must start clean");
    assert.equal(pool.getCursor("https://rpc-1.test"), null, "Old endpoint cursor must be cleared");
  });

  it("RpcPool switchNetwork clears all network cursors", () => {
    const pool = new RpcPool("https://testnet.stellar.org", [], "testnet");
    pool.setCursor("testnet-cursor-999");
    assert.equal(pool.getCursor(), "testnet-cursor-999");

    let networkChanged = false;
    pool.onNetworkChange(() => {
      networkChanged = true;
    });

    pool.switchNetwork("futurenet", "https://futurenet.stellar.org");

    assert.equal(pool.currentNetwork, "futurenet");
    assert.equal(pool.currentUrl, "https://futurenet.stellar.org");
    assert.equal(networkChanged, true);
    assert.equal(pool.getCursor(), null, "Cross-network cursor must be cleared immediately");
  });

  it("validateContinuity refuses cross-network or cross-endpoint transitions", () => {
    const pool = new RpcPool("https://rpc-a.test", []);

    // Same endpoint and matching passphrase -> valid continuity
    assert.equal(
      pool.validateContinuity(
        { endpoint: "https://rpc.test", passphrase: "Test SDF Network ; September 2015" },
        { endpoint: "https://rpc.test", passphrase: "Test SDF Network ; September 2015" },
      ),
      true,
    );

    // Mismatched passphrases (Testnet vs Mainnet) -> rejected continuity
    assert.equal(
      pool.validateContinuity(
        { endpoint: "https://rpc.test", passphrase: "Test SDF Network ; September 2015" },
        {
          endpoint: "https://rpc.test",
          passphrase: "Public Global Stellar Network ; September 2015",
        },
      ),
      false,
    );

    // Different endpoints without shared sync -> rejected continuity
    assert.equal(
      pool.validateContinuity(
        { endpoint: "https://rpc-a.test", network: "testnet" },
        { endpoint: "https://rpc-b.test", network: "testnet" },
      ),
      false,
    );
  });

  it("GuardFeedCoordinator abandons feed and resets cursor on endpoint change, preventing stale attribution", async () => {
    const feeds: ScriptedEndpointFeed[] = [];
    const coordinator = new GuardFeedCoordinator<ScriptedEndpointFeed>((guard, contextKey) => {
      const feed = new ScriptedEndpointFeed(guard, contextKey || "default");
      feeds.push(feed);
      return feed;
    });

    // 1. Initial endpoint A
    const feedA = coordinator.ensure("GUARD_1", "https://endpoint-a.stellar.org");
    assert.equal(feedA.cursor, null);

    // Poll endpoint A: delivers event from A and advances cursor
    const pageA1 = await feedA.pollOnce();
    assert.equal(pageA1.events.length, 1);
    assert.equal(pageA1.events[0], "event-from-https://endpoint-a.stellar.org");
    assert.equal(feedA.cursor, "https://endpoint-a.stellar.org-cursor-1");

    // 2. Switch endpoint to B (same guard, different endpoint context)
    const feedB = coordinator.ensure("GUARD_1", "https://endpoint-b.stellar.org");

    // Proves coordinator abandoned old feed and created fresh one
    assert.notEqual(feedA, feedB);
    assert.equal(coordinator.statsSnapshot().abandoned, 1);
    assert.equal(coordinator.statsSnapshot().created, 2);

    // Feed B must start with NULL cursor, NOT feed A's cursor
    assert.equal(feedB.cursor, null, "Feed on new endpoint must have reset/null cursor");

    // Poll endpoint B: proves events from B are received, NOT skipped by A's cursor
    const pageB1 = await feedB.pollOnce();
    assert.equal(pageB1.events.length, 1);
    assert.equal(pageB1.events[0], "event-from-https://endpoint-b.stellar.org");
    assert.equal(feedB.cursor, "https://endpoint-b.stellar.org-cursor-1");

    // 3. Rapid switch back to A (A -> B -> A) must produce a FRESH feed, never resurrecting old cursor
    const feedA2 = coordinator.ensure("GUARD_1", "https://endpoint-a.stellar.org");
    assert.notEqual(feedA, feedA2);
    assert.equal(feedA2.cursor, null, "Resumed endpoint must still receive fresh unpoisoned feed");
    assert.equal(coordinator.statsSnapshot().abandoned, 2);
  });
});

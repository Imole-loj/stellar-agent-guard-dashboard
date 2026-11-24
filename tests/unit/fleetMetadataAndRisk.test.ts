import assert from "node:assert/strict";
import { afterEach, before, describe, it, test } from "node:test";
import {
  addGuardTag,
  computeFleetRiskSummary,
  derivePolicyAge,
  filterFleet,
  formatAge,
  getAllFleetTags,
  getGuardTags,
  getPreferredDisplayName,
  loadFleetDisplayNames,
  loadFleetTags,
  removeGuardTag,
  setPreferredDisplayName,
  type FleetRow,
  type PolicyAge,
} from "../../lib/guard/fleet.ts";
import type { StorageLike } from "../../lib/guard/instance.ts";
import { installDom, loadReact } from "./domHarness.ts";
import { FleetRiskSummaryCard } from "../../components/FleetTable.tsx";

function createMemoryStorage(): StorageLike {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
  };
}

describe("fleet metadata tags (#472)", () => {
  it("allows multiple local tags per guard and keeps them network-scoped", () => {
    const storage = createMemoryStorage();
    const net1 = "Testnet";
    const net2 = "Public";
    const addr1 = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const addr2 = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

    // Add tags to guard 1 on Testnet
    addGuardTag(net1, addr1, "treasury", storage);
    addGuardTag(net1, addr1, "prod", storage);

    // Add tag to guard 2 on Testnet
    addGuardTag(net1, addr2, "trading", storage);

    // Add tag to guard 1 on Public (different network)
    addGuardTag(net2, addr1, "mainnet-live", storage);

    assert.deepEqual(getGuardTags(net1, addr1, storage), ["treasury", "prod"]);
    assert.deepEqual(getGuardTags(net1, addr2, storage), ["trading"]);
    assert.deepEqual(getGuardTags(net2, addr1, storage), ["mainnet-live"]);
    assert.deepEqual(getGuardTags(net2, addr2, storage), []);

    assert.deepEqual(getAllFleetTags(net1, storage), ["prod", "trading", "treasury"]);

    // Remove a tag
    removeGuardTag(net1, addr1, "treasury", storage);
    assert.deepEqual(getGuardTags(net1, addr1, storage), ["prod"]);
  });

  it("filters fleet rows by operator tag", () => {
    const rows: FleetRow[] = [
      {
        contact: { address: "C1", label: "Guard 1", addedAt: "" },
        snapshot: null,
        derivedStatus: "Active",
        spend24h: 0n,
        dmsCountdownSecs: null,
        network: "Testnet",
        tags: ["treasury", "ops"],
      },
      {
        contact: { address: "C2", label: "Guard 2", addedAt: "" },
        snapshot: null,
        derivedStatus: "Active",
        spend24h: 0n,
        dmsCountdownSecs: null,
        network: "Testnet",
        tags: ["trading"],
      },
    ];

    const treasuryOnly = filterFleet(rows, "", null, null, "treasury");
    assert.equal(treasuryOnly.length, 1);
    assert.equal(treasuryOnly[0]!.contact.address, "C1");

    const tradingOnly = filterFleet(rows, "", null, null, "trading");
    assert.equal(tradingOnly.length, 1);
    assert.equal(tradingOnly[0]!.contact.address, "C2");

    const unknownTag = filterFleet(rows, "", null, null, "nonexistent");
    assert.equal(unknownTag.length, 0);
  });
});

describe("preferred display names per guard (#473)", () => {
  it("supports local display names and duplicate names without conflating identities", () => {
    const storage = createMemoryStorage();
    const net = "Testnet";
    const addr1 = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const addr2 = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

    // Set identical display names for two different guard addresses
    setPreferredDisplayName(net, addr1, "Treasury Vault", storage);
    setPreferredDisplayName(net, addr2, "Treasury Vault", storage);

    assert.equal(getPreferredDisplayName(net, addr1, "Fallback 1", storage), "Treasury Vault");
    assert.equal(getPreferredDisplayName(net, addr2, "Fallback 2", storage), "Treasury Vault");

    // Two rows with duplicate display names retain distinct identities by address
    const rows: FleetRow[] = [
      {
        contact: { address: addr1, label: "Initial 1", addedAt: "" },
        snapshot: null,
        derivedStatus: "Active",
        spend24h: 0n,
        dmsCountdownSecs: null,
        network: net,
        displayName: getPreferredDisplayName(net, addr1, "Initial 1", storage),
      },
      {
        contact: { address: addr2, label: "Initial 2", addedAt: "" },
        snapshot: null,
        derivedStatus: "Active",
        spend24h: 0n,
        dmsCountdownSecs: null,
        network: net,
        displayName: getPreferredDisplayName(net, addr2, "Initial 2", storage),
      },
    ];

    assert.equal(rows[0]!.displayName, rows[1]!.displayName);
    assert.notEqual(rows[0]!.contact.address, rows[1]!.contact.address);

    // Searching by display name finds both without collapsing them
    const matches = filterFleet(rows, "treasury", null, null);
    assert.equal(matches.length, 2);
    assert.equal(matches[0]!.contact.address, addr1);
    assert.equal(matches[1]!.contact.address, addr2);
  });
});

describe("policy installation age in fleet view (#474)", () => {
  it("derives policy age strictly from on-chain timestamps", () => {
    // Valid on-chain timestamp: now = 1000s, active_from = 800s -> age = 200s (3m)
    const validSnapshot: any = {
      status: { ok: true, value: { now: 1000n } },
      policy: { ok: true, value: { active_from: 800n } },
    };
    const age = derivePolicyAge(validSnapshot);
    assert.equal(age.derivable, true);
    assert.equal(age.ageSecs, 200n);
    assert.equal(age.display, "3m");
  });

  it("shows unavailable when timestamp cannot be derived from chain data", () => {
    // Missing active_from (0n)
    const zeroActiveFrom: any = {
      status: { ok: true, value: { now: 1000n } },
      policy: { ok: true, value: { active_from: 0n } },
    };
    assert.deepEqual(derivePolicyAge(zeroActiveFrom), {
      derivable: false,
      ageSecs: null,
      display: "unavailable",
    });

    // Policy read failed
    const failedPolicy: any = {
      status: { ok: true, value: { now: 1000n } },
      policy: { ok: false, error: "Contract error" },
    };
    assert.deepEqual(derivePolicyAge(failedPolicy), {
      derivable: false,
      ageSecs: null,
      display: "unavailable",
    });

    // Null snapshot
    assert.deepEqual(derivePolicyAge(null), {
      derivable: false,
      ageSecs: null,
      display: "unavailable",
    });
  });

  it("formats age intervals into clean compact units", () => {
    assert.equal(formatAge(30n), "30s");
    assert.equal(formatAge(150n), "2m");
    assert.equal(formatAge(7200n), "2h");
    assert.equal(formatAge(172800n), "2d");
  });
});

describe("read-only fleet risk summary (#475)", () => {
  let React: Awaited<ReturnType<typeof loadReact>>["react"];
  let createRoot: Awaited<ReturnType<typeof loadReact>>["createRoot"];
  let act: Awaited<ReturnType<typeof loadReact>>["act"];
  let root: ReturnType<typeof createRoot> | null = null;

  before(async () => {
    installDom();
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
  });

  it("aggregates only successful live reads and lists failed/excluded guards", () => {
    const rows: FleetRow[] = [
      {
        contact: { address: "C_ACTIVE", label: "Active Guard", addedAt: "" },
        snapshot: {
          guard: "C_ACTIVE",
          fetchedAt: "",
          status: { ok: true, value: { admin_frozen: false, heartbeat_expired: false } as any },
          policy: { ok: true, value: { active_from: 100n } as any },
          window: { ok: true, value: null },
          identity: { ok: true, value: null as any },
        },
        derivedStatus: "Active",
        spend24h: 0n,
        dmsCountdownSecs: 100n,
        network: "Testnet",
      },
      {
        contact: { address: "C_FROZEN", label: "Frozen Guard", addedAt: "" },
        snapshot: {
          guard: "C_FROZEN",
          fetchedAt: "",
          status: { ok: true, value: { admin_frozen: true, heartbeat_expired: false } as any },
          policy: { ok: true, value: { active_from: 100n } as any },
          window: { ok: true, value: null },
          identity: { ok: true, value: null as any },
        },
        derivedStatus: "Frozen",
        spend24h: 0n,
        dmsCountdownSecs: null,
        network: "Testnet",
      },
      {
        contact: { address: "C_EXPIRED", label: "Expired Guard", addedAt: "" },
        snapshot: {
          guard: "C_EXPIRED",
          fetchedAt: "",
          status: { ok: true, value: { admin_frozen: false, heartbeat_expired: true } as any },
          policy: { ok: true, value: { active_from: 100n } as any },
          window: { ok: true, value: null },
          identity: { ok: true, value: null as any },
        },
        derivedStatus: "Expired",
        spend24h: 0n,
        dmsCountdownSecs: 0n,
        network: "Testnet",
      },
      {
        contact: { address: "C_NO_POLICY", label: "No Policy Guard", addedAt: "" },
        snapshot: {
          guard: "C_NO_POLICY",
          fetchedAt: "",
          status: { ok: true, value: { admin_frozen: false, heartbeat_expired: false } as any },
          policy: { ok: true, value: null },
          window: { ok: true, value: null },
          identity: { ok: true, value: null as any },
        },
        derivedStatus: "Active",
        spend24h: 0n,
        dmsCountdownSecs: null,
        network: "Testnet",
      },
      {
        contact: { address: "C_FAILED", label: "Failed Guard", addedAt: "" },
        snapshot: null,
        error: "Connection timeout",
        derivedStatus: "Unknown",
        spend24h: 0n,
        dmsCountdownSecs: null,
        network: "Testnet",
      },
    ];

    const summary = computeFleetRiskSummary(rows);
    assert.equal(summary.totalGuards, 5);
    assert.equal(summary.successfulReads, 4);

    assert.equal(summary.frozen.length, 1);
    assert.equal(summary.frozen[0]!.address, "C_FROZEN");

    assert.equal(summary.expiredDms.length, 1);
    assert.equal(summary.expiredDms[0]!.address, "C_EXPIRED");

    assert.equal(summary.missingPolicy.length, 1);
    assert.equal(summary.missingPolicy[0]!.address, "C_NO_POLICY");

    assert.equal(summary.activeHealthy.length, 1);
    assert.equal(summary.activeHealthy[0]!.address, "C_ACTIVE");

    assert.equal(summary.failedOrExcluded.length, 1);
    assert.equal(summary.failedOrExcluded[0]!.address, "C_FAILED");
    assert.equal(summary.failedOrExcluded[0]!.error, "Connection timeout");
  });

  test("FleetRiskSummaryCard renders categories and enables direct navigation", async () => {
    let inspectedGuard: string | null = null;
    const rows: FleetRow[] = [
      {
        contact: { address: "C_FROZEN_1", label: "Frozen Alpha", addedAt: "" },
        snapshot: {
          guard: "C_FROZEN_1",
          fetchedAt: "",
          status: { ok: true, value: { admin_frozen: true, heartbeat_expired: false } as any },
          policy: { ok: true, value: {} as any },
          window: { ok: true, value: null },
          identity: { ok: true, value: null as any },
        },
        derivedStatus: "Frozen",
        spend24h: 0n,
        dmsCountdownSecs: null,
        network: "Testnet",
      },
      {
        contact: { address: "C_FAILED_1", label: "Offline Beta", addedAt: "" },
        snapshot: null,
        error: "RPC unreachable",
        derivedStatus: "Unknown",
        spend24h: 0n,
        dmsCountdownSecs: null,
        network: "Testnet",
      },
    ];

    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);

    await act(() => {
      root!.render(
        React.createElement(FleetRiskSummaryCard, {
          rows,
          onSelectGuard: (addr) => {
            inspectedGuard = addr;
          },
        }),
      );
    });

    const card = document.querySelector('[data-testid="fleet-risk-summary"]');
    assert.ok(card, "risk summary card is rendered");

    const frozenPill = document.querySelector('[data-testid="risk-card-frozen"]');
    assert.ok(frozenPill, "frozen risk category is rendered");
    assert.match(frozenPill.textContent || "", /1 Frozen/);

    const excludedList = document.querySelector('[data-testid="excluded-guards-list"]');
    assert.ok(excludedList, "excluded guards list is rendered");
    assert.match(excludedList.textContent || "", /RPC unreachable/);

    // Click on frozen guard to test navigation
    const frozenBtn = frozenPill.querySelector("button") as HTMLButtonElement;
    assert.ok(frozenBtn, "inspect button for frozen guard is rendered");
    await act(() => {
      frozenBtn.click();
    });
    assert.equal(inspectedGuard, "C_FROZEN_1", "clicking risk item navigates to that guard");
  });
});

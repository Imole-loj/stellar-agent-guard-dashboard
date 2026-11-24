import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_FLEET_COLUMNS,
  FLEET_COLUMNS_STORAGE_KEY,
  loadFleetColumns,
  saveFleetColumns,
  resetFleetColumns,
  type FleetColumnConfig,
} from "../../lib/guard/fleetTableState.ts";
import {
  generateFleetPolicyReport,
  formatFleetPolicyReportMarkdown,
  type FleetRow,
} from "../../lib/guard/fleet.ts";
import { previewRegistryMerge, isValidGuardAddress } from "../../lib/guard/registry.ts";
import {
  rememberInstance,
  loadSavedInstances,
  type GuardInstance,
} from "../../lib/guard/instance.ts";

const VALID_GUARD_1 = "CDMBPI64FS3RZW6G23NCDPLBY5GTKX7TSVZZSHE6ZQX4XAIV3HCPXUDJ";
const VALID_GUARD_2 = "CB2M5YFEI74KVKZVES4UQNY3FLHMYE5R24EY2OSHB5LJH5FI2IJMSP5I";
const VALID_GUARD_3 = "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44";
const INVALID_GUARD = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, String(v)),
    removeItem: (k: string) => store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size;
    },
  };
}

test("Fleet column layout preferences (#476)", async (t) => {
  await t.test("loads default column configuration when storage is empty", () => {
    const storage = createMemoryStorage();
    const cols = loadFleetColumns(storage);
    assert.deepEqual(cols, DEFAULT_FLEET_COLUMNS);
    assert.equal(cols.find((c) => c.id === "guard")?.canHide, false);
    assert.equal(cols.find((c) => c.id === "selection")?.canHide, false);
  });

  await t.test("persists modified visibility and reordered columns", () => {
    const storage = createMemoryStorage();
    const custom: FleetColumnConfig[] = [
      { id: "selection", label: "Select", visible: true, canHide: false },
      { id: "guard", label: "Guard", visible: true, canHide: false },
      { id: "spend", label: "24h Spend", visible: true, canHide: true },
      { id: "status", label: "Status", visible: false, canHide: true },
      { id: "network", label: "Network", visible: false, canHide: true },
      { id: "dms", label: "DMS Countdown", visible: true, canHide: true },
      { id: "actions", label: "Actions", visible: true, canHide: true },
    ];
    saveFleetColumns(custom, storage);

    const loaded = loadFleetColumns(storage);
    assert.equal(loaded[2]?.id, "spend");
    assert.equal(loaded.find((c) => c.id === "status")?.visible, false);
    assert.equal(loaded.find((c) => c.id === "network")?.visible, false);
    assert.equal(loaded.find((c) => c.id === "guard")?.visible, true);
  });

  await t.test("prevents hiding mandatory columns like guard and selection", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      FLEET_COLUMNS_STORAGE_KEY,
      JSON.stringify([
        { id: "selection", visible: false },
        { id: "guard", visible: false },
      ]),
    );

    const loaded = loadFleetColumns(storage);
    assert.equal(loaded.find((c) => c.id === "selection")?.visible, true);
    assert.equal(loaded.find((c) => c.id === "guard")?.visible, true);
  });

  await t.test("resets column layout back to factory defaults", () => {
    const storage = createMemoryStorage();
    saveFleetColumns(
      [
        { id: "selection", label: "Select", visible: true, canHide: false },
        { id: "spend", label: "24h Spend", visible: true, canHide: true },
      ],
      storage,
    );
    assert.ok(storage.getItem(FLEET_COLUMNS_STORAGE_KEY));

    const reset = resetFleetColumns(storage);
    assert.deepEqual(reset, DEFAULT_FLEET_COLUMNS);
    assert.equal(storage.getItem(FLEET_COLUMNS_STORAGE_KEY), null);
  });
});

test("Safe multi-guard policy review report (#477)", async (t) => {
  const row1: FleetRow = {
    contact: { address: VALID_GUARD_1, label: "Guard 1", addedAt: "" },
    network: "testnet",
    derivedStatus: "Active",
    spend24h: 1000n,
    dmsCountdownSecs: 300n,
    snapshot: {
      guard: VALID_GUARD_1,
      status: {
        ok: true,
        value: {
          admin_frozen: false,
          heartbeat_expired: false,
          last_heartbeat: 100n,
          now: 150n,
          has_policy: true,
        },
      },
      policy: {
        ok: true,
        value: {
          per_tx_cap: 10_0000000n,
          window_cap: 50_0000000n,
          window_secs: 86400n,
          dms_grace_secs: 3600n,
        } as any,
      },
      window: { ok: true, value: { total: 1000n, entries: [] } } as any,
      identity: { ok: true, value: {} } as any,
      fetchedAt: "2024-01-01T00:00:00Z",
    },
  };

  const row2: FleetRow = {
    contact: { address: VALID_GUARD_2, label: "Guard 2", addedAt: "" },
    network: "testnet",
    derivedStatus: "Unknown",
    spend24h: 0n,
    dmsCountdownSecs: null,
    snapshot: null,
    error: "RPC timeout",
  };

  await t.test("generates complete report when all reads succeed", () => {
    const report = generateFleetPolicyReport([row1]);
    assert.equal(report.totalGuards, 1);
    assert.equal(report.successfulReads, 1);
    assert.equal(report.failedReads, 0);
    assert.equal(report.isPartial, false);
    assert.equal(report.entries[0]?.readOutcome, "success");
    assert.equal(report.entries[0]?.hasPolicy, true);
    assert.match(report.entries[0]?.policySummary ?? "", /Per-Tx: 10/);
  });

  await t.test(
    "marks report as partial and highlights failed reads without masking as empty policies",
    () => {
      const report = generateFleetPolicyReport([row1, row2]);
      assert.equal(report.totalGuards, 2);
      assert.equal(report.successfulReads, 1);
      assert.equal(report.failedReads, 1);
      assert.equal(report.isPartial, true);

      const failedEntry = report.entries.find((e) => e.guard === row2.contact.address);
      assert.ok(failedEntry);
      assert.equal(failedEntry.readOutcome, "failed");
      assert.equal(failedEntry.error, "RPC timeout");
      assert.equal(failedEntry.hasPolicy, null);
      assert.match(failedEntry.policySummary, /READ FAILED/);
    },
  );

  await t.test("formats markdown report with explicit partial banner and table headers", () => {
    const report = generateFleetPolicyReport([row1, row2]);
    const md = formatFleetPolicyReportMarkdown(report);
    assert.match(md, /# Fleet Policy Review Report/);
    assert.match(md, /PARTIAL \(One or more guard reads failed\)/);
    assert.match(md, /READ FAILED: RPC timeout/);
  });
});

test("Absent guard registration (#478)", async (t) => {
  await t.test("validates Soroban contract address format", () => {
    assert.equal(isValidGuardAddress(VALID_GUARD_1), true);
    assert.equal(isValidGuardAddress(INVALID_GUARD), false);
    assert.equal(isValidGuardAddress("short"), false);
  });

  await t.test("registers guard locally without touching chain", () => {
    const storage = createMemoryStorage();
    const initial = loadSavedInstances({ network: "testnet", storage });
    assert.equal(initial.length, 0);

    const updated = rememberInstance(VALID_GUARD_1, "New Deployed Guard", {
      network: "testnet",
      storage,
    });
    assert.ok(
      updated.some((inst) => inst.guard === VALID_GUARD_1 && inst.label === "New Deployed Guard"),
    );
  });
});

test("Guarded local registry merge preview (#479)", async (t) => {
  const current: GuardInstance[] = [
    {
      guard: VALID_GUARD_1,
      label: "Current Guard 1",
      network: "testnet",
      addedAt: "2024-01-01T00:00:00Z",
      provenance: "test",
    },
    {
      guard: VALID_GUARD_3,
      label: "Current Guard 3",
      network: "testnet",
      addedAt: "2024-01-01T00:00:00Z",
      provenance: "test",
    },
  ];

  await t.test("rejects non-object or non-array import payloads", () => {
    const preview1 = previewRegistryMerge(current, "invalid-json");
    assert.equal(preview1.ok, false);
    assert.match(preview1.error ?? "", /JSON/);

    const preview2 = previewRegistryMerge(current, { somethingElse: true });
    assert.equal(preview2.ok, false);
  });

  await t.test(
    "categorizes additions, duplicates, conflicts, and invalid entries without storage changes",
    () => {
      const importPayload = [
        // Addition (new guard)
        { guard: VALID_GUARD_2, label: "Imported Guard 2", network: "testnet" },
        // Duplicate skip (identical label and network)
        { guard: VALID_GUARD_1, label: "Current Guard 1", network: "testnet" },
        // Conflict (existing guard with differing label)
        { guard: VALID_GUARD_3, label: "Conflicting Label", network: "testnet" },
        // Invalid (bad address checksum)
        { guard: INVALID_GUARD, label: "Bad Guard" },
      ];

      const preview = previewRegistryMerge(current, importPayload, "testnet");
      assert.equal(preview.ok, true);
      assert.equal(preview.additions.length, 1);
      assert.equal(preview.additions[0]?.guard, VALID_GUARD_2);
      assert.equal(preview.conflicts.length, 1);
      assert.equal(preview.conflicts[0]?.guard, VALID_GUARD_3);
      assert.equal(preview.skips.length, 1);
      assert.equal(preview.skips[0]?.guard, VALID_GUARD_1);
      assert.equal(preview.invalid.length, 1);
      assert.match(preview.invalid[0]?.reason ?? "", /Invalid/);
    },
  );

  await t.test("detects conflicts when same address has differing label or network", () => {
    const importPayload = [{ guard: VALID_GUARD_1, label: "Changed Label", network: "testnet" }];
    const preview = previewRegistryMerge(current, importPayload, "testnet");
    assert.equal(preview.ok, true);
    assert.equal(preview.conflicts.length, 1);
    assert.equal(preview.conflicts[0]?.currentLabel, "Current Guard 1");
    assert.equal(preview.conflicts[0]?.importedLabel, "Changed Label");
  });
});

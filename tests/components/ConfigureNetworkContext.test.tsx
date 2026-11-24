import assert from "node:assert/strict";
import { test } from "node:test";
import { installDom, loadReact } from "../unit/domHarness.ts";
import { ConfigureNetworkContext, rpcHostname } from "../../components/ConfigureNetworkContext.tsx";
import type { ReadOnlyProbeResult } from "../../lib/guard/network.ts";

test("configure network context shows the network and full RPC hostname", async () => {
  installDom();
  const { react, createRoot, act } = await loadReact();
  const container = document.createElement("div");
  const root = createRoot(container);

  try {
    await act(async () => {
      root.render(
        react.createElement(ConfigureNetworkContext, {
          networkName: "futurenet",
          rpcUrl: "https://rpc.example.test/soroban",
        }),
      );
    });

    assert.equal(
      container.querySelector('[data-testid="configure-network-name"]')?.textContent,
      "futurenet",
    );
    const hostname = container.querySelector<HTMLElement>('[data-testid="configure-rpc-hostname"]');
    assert.equal(hostname?.textContent, "rpc.example.test");
    assert.equal(hostname?.title, "https://rpc.example.test/soroban");
    assert.equal(container.querySelector("button, select"), null);
  } finally {
    act(() => root.unmount());
    document.body.innerHTML = "";
  }
});

test("RPC hostname extraction keeps malformed endpoint configuration visible", () => {
  assert.equal(rpcHostname("not a URL"), "not a URL");
});

test("redacts credentials from endpoint URL in DOM title attribute (#507)", async () => {
  installDom();
  const { react, createRoot, act } = await loadReact();
  const container = document.createElement("div");
  const root = createRoot(container);

  try {
    await act(async () => {
      root.render(
        react.createElement(ConfigureNetworkContext, {
          networkName: "testnet",
          rpcUrl: "https://ops:hunter2@soroban-testnet.stellar.org/soroban/rpc?token=secret123",
        }),
      );
    });

    const hostname = container.querySelector<HTMLElement>('[data-testid="configure-rpc-hostname"]');
    assert.equal(hostname?.textContent, "soroban-testnet.stellar.org");
    assert.doesNotMatch(hostname?.title ?? "", /hunter2/);
    assert.doesNotMatch(hostname?.title ?? "", /secret123/);
    assert.match(
      hostname?.title ?? "",
      /https:\/\/\[redacted\]@soroban-testnet\.stellar\.org\/soroban\/rpc\?token=\[redacted\]/,
    );
  } finally {
    act(() => root.unmount());
    document.body.innerHTML = "";
  }
});

test("interactive mode explains read-only versus write endpoint roles (#508)", async () => {
  installDom();
  const { react, createRoot, act } = await loadReact();
  const container = document.createElement("div");
  const root = createRoot(container);

  try {
    await act(async () => {
      root.render(
        react.createElement(ConfigureNetworkContext, {
          networkName: "testnet",
          rpcUrl: "https://soroban-testnet.stellar.org",
          interactive: true,
        }),
      );
    });

    const rolesSection = container.querySelector('[data-testid="network-roles-explanation"]');
    assert.notEqual(
      rolesSection,
      null,
      "Roles explanation section must be present in interactive mode",
    );

    const readOnlyDesc =
      container.querySelector('[data-testid="role-read-only"]')?.textContent ?? "";
    const writeDesc =
      container.querySelector('[data-testid="role-write-network"]')?.textContent ?? "";

    assert.match(readOnlyDesc, /non-custodial queries/i);
    assert.match(readOnlyDesc, /holds no keys/i);
    assert.match(writeDesc, /wallet/i);
    assert.match(writeDesc, /signs and broadcasts transactions/i);
  } finally {
    act(() => root.unmount());
    document.body.innerHTML = "";
  }
});

test("operator can trigger read-only endpoint probe and view latency and network identity (#506)", async () => {
  installDom();
  const { react, createRoot, act } = await loadReact();
  const container = document.createElement("div");
  const root = createRoot(container);

  const fakeProbe = async (): Promise<ReadOnlyProbeResult> => ({
    ok: true,
    endpointOrigin: "https://soroban-testnet.stellar.org",
    latencyMs: 42,
    passphrase: "Test SDF Network ; September 2015",
    protocolVersion: 22,
    networkName: "Testnet",
  });

  try {
    await act(async () => {
      root.render(
        react.createElement(ConfigureNetworkContext, {
          networkName: "testnet",
          rpcUrl: "https://soroban-testnet.stellar.org",
          interactive: true,
          probeImpl: fakeProbe,
        }),
      );
    });

    const probeButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="probe-endpoint-button"]',
    );
    assert.notEqual(probeButton, null);

    // Click probe
    await act(async () => {
      probeButton?.click();
    });

    const latencyEl = container.querySelector('[data-testid="probe-latency"]');
    const identityEl = container.querySelector('[data-testid="probe-network-identity"]');

    assert.equal(latencyEl?.textContent?.trim(), "42 ms");
    assert.match(identityEl?.textContent ?? "", /Testnet/);
    assert.match(identityEl?.textContent ?? "", /Test SDF Network ; September 2015/);
  } finally {
    act(() => root.unmount());
    document.body.innerHTML = "";
  }
});

test("operator probe displays redacted error on probe failure (#506, #507)", async () => {
  installDom();
  const { react, createRoot, act } = await loadReact();
  const container = document.createElement("div");
  const root = createRoot(container);

  const fakeFailingProbe = async (): Promise<ReadOnlyProbeResult> => ({
    ok: false,
    endpointOrigin: "https://soroban-testnet.stellar.org",
    latencyMs: 15,
    failure: "network",
    detail: "connection refused to https://ops:[redacted]@rpc.test",
  });

  try {
    await act(async () => {
      root.render(
        react.createElement(ConfigureNetworkContext, {
          networkName: "testnet",
          rpcUrl: "https://soroban-testnet.stellar.org",
          interactive: true,
          probeImpl: fakeFailingProbe,
        }),
      );
    });

    const probeButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="probe-endpoint-button"]',
    );
    await act(async () => {
      probeButton?.click();
    });

    const errorEl = container.querySelector('[data-testid="probe-error"]');
    assert.notEqual(errorEl, null);
    assert.match(errorEl?.textContent ?? "", /connection refused/);
    assert.match(errorEl?.textContent ?? "", /\[redacted\]/);
  } finally {
    act(() => root.unmount());
    document.body.innerHTML = "";
  }
});

test("changing write network requires explicit confirmation before calling callback (#508)", async () => {
  installDom();
  const { react, createRoot, act } = await loadReact();
  const container = document.createElement("div");
  const root = createRoot(container);

  let confirmedTarget: string | null = null;
  const onConfirm = (target: string) => {
    confirmedTarget = target;
  };

  try {
    await act(async () => {
      root.render(
        react.createElement(ConfigureNetworkContext, {
          networkName: "testnet",
          rpcUrl: "https://soroban-testnet.stellar.org",
          walletPassphrase: "Public Global Stellar Network ; September 2015", // Mainnet mismatch
          walletNetwork: "public",
          interactive: true,
          onConfirmWriteNetwork: onConfirm,
        }),
      );
    });

    // Mismatch banner is displayed
    const mismatchBanner = container.querySelector('[data-testid="network-mismatch-banner"]');
    assert.notEqual(mismatchBanner, null);
    assert.match(
      container.querySelector('[data-testid="mismatch-headline"]')?.textContent ?? "",
      /Wallet on Mainnet, dashboard on Testnet/,
    );

    // Request write switch button
    const requestBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="request-write-network-switch"]',
    );
    assert.notEqual(requestBtn, null);

    // Initial click does NOT execute change immediately
    await act(async () => {
      requestBtn?.click();
    });
    assert.equal(confirmedTarget, null, "Must not change write network on first unconfirmed click");

    // Confirmation dialog is shown
    const confirmDialog = container.querySelector('[data-testid="write-network-confirm-dialog"]');
    assert.notEqual(confirmDialog, null);
    assert.match(confirmDialog?.textContent ?? "", /Explicit confirmation required/);

    // Operator clicks Cancel
    const cancelBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="cancel-write-network-switch"]',
    );
    await act(async () => {
      cancelBtn?.click();
    });
    assert.equal(confirmedTarget, null, "Cancelling must not execute change");
    assert.equal(
      container.querySelector('[data-testid="write-network-confirm-dialog"]'),
      null,
      "Dialog dismissed after cancel",
    );

    // Click request again, then Confirm
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="request-write-network-switch"]')
        ?.click();
    });
    const confirmBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="confirm-write-network-switch"]',
    );
    await act(async () => {
      confirmBtn?.click();
    });

    assert.equal(confirmedTarget, "testnet", "Explicit confirmation executed write network change");
  } finally {
    act(() => root.unmount());
    document.body.innerHTML = "";
  }
});

import assert from "node:assert/strict";
import { afterEach, before, describe, test } from "node:test";
import {
  getPendingDisconnectGuidance,
  getPendingWrite,
  setPendingWrite,
  subscribePendingWrite,
} from "../../lib/guard/writeReview.ts";
import { installDom, loadReact } from "./domHarness.ts";
import { PendingDisconnectModal } from "../../components/WalletBar.tsx";

describe("pending disconnect guidance (#516)", () => {
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
    setPendingWrite(null);
    if (root) {
      act(() => {
        root!.unmount();
      });
      root = null;
    }
    document.body.innerHTML = "";
  });

  test("produces stage-specific disconnect guidance without false cancellation claims", () => {
    // 1. Submission phase: broadcast may have already happened
    const subGuidance = getPendingDisconnectGuidance("submission", "deadbeef1234");
    assert.equal(subGuidance.canCancelSafely, false);
    assert.match(subGuidance.detail, /will NOT cancel/i);
    assert.match(subGuidance.outcomeExplanation, /cannot be cancelled by disconnecting/i);
    assert.match(subGuidance.lookupGuidance, /deadbeef1234/);

    const subGuidanceNoHash = getPendingDisconnectGuidance("submission");
    assert.match(subGuidanceNoHash.lookupGuidance, /Transaction History or Horizon\/RPC/i);

    // 2. Envelope signing phase: signed locally but not broadcast
    const envGuidance = getPendingDisconnectGuidance("envelope");
    assert.equal(envGuidance.canCancelSafely, true);
    assert.match(envGuidance.detail, /not yet been broadcast/i);
    assert.match(envGuidance.lookupGuidance, /Transaction History/i);

    // 3. Pre-flight phases (discovery, authorization)
    const discGuidance = getPendingDisconnectGuidance("discovery");
    assert.equal(discGuidance.canCancelSafely, true);
    assert.match(discGuidance.outcomeExplanation, /Nothing was broadcast/i);

    const authGuidance = getPendingDisconnectGuidance("authorization");
    assert.equal(authGuidance.canCancelSafely, true);
    assert.match(authGuidance.outcomeExplanation, /Nothing was broadcast/i);
  });

  test("manages pending write lifecycle and subscriber notifications", () => {
    let notified = 0;
    const unsubscribe = subscribePendingWrite(() => {
      notified++;
    });

    assert.equal(getPendingWrite(), null);

    setPendingWrite("discovery");
    assert.equal(getPendingWrite()?.phase, "discovery");
    assert.equal(notified, 1);

    setPendingWrite("submission", "tx12345");
    assert.equal(getPendingWrite()?.phase, "submission");
    assert.equal(getPendingWrite()?.txHash, "tx12345");
    assert.equal(notified, 2);

    setPendingWrite(null);
    assert.equal(getPendingWrite(), null);
    assert.equal(notified, 3);

    unsubscribe();
    setPendingWrite("envelope");
    assert.equal(notified, 3, "unsubscribed listener receives no further notifications");
  });

  test("PendingDisconnectModal renders stage details and lookup instructions", async () => {
    let confirmed = false;
    let closed = false;

    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);

    await act(() => {
      root!.render(
        React.createElement(PendingDisconnectModal, {
          pendingWrite: { phase: "submission", txHash: "abc123hash" },
          onConfirm: () => {
            confirmed = true;
          },
          onClose: () => {
            closed = true;
          },
        }),
      );
    });

    const modal = document.querySelector('[data-testid="disconnect-pending-warning"]');
    assert.ok(modal, "modal element is rendered");
    assert.match(modal.textContent || "", /A transaction is currently being submitted/i);
    assert.match(modal.textContent || "", /will NOT cancel the transaction/i);
    assert.match(modal.textContent || "", /abc123hash/);

    const buttons = Array.from(document.querySelectorAll("button"));
    const disconnectBtn = buttons.find((b) => b.textContent?.includes("Disconnect anyway"));
    const waitBtn = buttons.find((b) => b.textContent?.includes("Keep waiting"));

    assert.ok(disconnectBtn, "disconnect anyway button is present");
    assert.ok(waitBtn, "keep waiting button is present");

    await act(() => {
      disconnectBtn.click();
    });
    assert.equal(confirmed, true);

    await act(() => {
      waitBtn.click();
    });
    assert.equal(closed, true);
  });
});

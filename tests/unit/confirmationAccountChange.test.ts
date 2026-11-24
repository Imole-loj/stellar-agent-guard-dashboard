import assert from "node:assert/strict";
import { afterEach, before, describe, test } from "node:test";
import { installDom, loadReact } from "./domHarness.ts";
import { PolicyDiffModal } from "../../components/PolicyDiffModal.tsx";
import type { PolicyDiff } from "../../lib/guard/policyDiff.ts";

const SAMPLE_DIFF: PolicyDiff = {
  entries: [{ field: "per_tx_cap", oldValue: 1000n, newValue: 2000n, status: "modified" }],
  warnings: [],
};

describe("confirmation dialog account change protection (#515)", () => {
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

  async function renderPolicyDiffModal(
    props: {
      expectedAccount?: string;
      currentAccount?: string;
      onConfirm?: () => void;
      onCancel?: () => void;
    } = {},
  ): Promise<void> {
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(() => {
      root!.render(
        React.createElement(PolicyDiffModal, {
          diff: SAMPLE_DIFF,
          expectedAccount:
            props.expectedAccount ?? "GBBD7223BM5VCEOR2G26KDW6Y4G6ZUNS5U67GZ2BGB26KDW6Y4G6ZUNS",
          currentAccount:
            props.currentAccount ?? "GBBD7223BM5VCEOR2G26KDW6Y4G6ZUNS5U67GZ2BGB26KDW6Y4G6ZUNS",
          onConfirm: props.onConfirm ?? (() => {}),
          onCancel: props.onCancel ?? (() => {}),
        }),
      );
    });
  }

  test("allows confirm when the active account matches expected", async () => {
    let confirmed = false;
    await renderPolicyDiffModal({
      expectedAccount: "GBBD7223BM5VCEOR2G26KDW6Y4G6ZUNS5U67GZ2BGB26KDW6Y4G6ZUNS",
      currentAccount: "GBBD7223BM5VCEOR2G26KDW6Y4G6ZUNS5U67GZ2BGB26KDW6Y4G6ZUNS",
      onConfirm: () => {
        confirmed = true;
      },
    });

    const warning = document.querySelector('[data-testid="confirmation-account-changed"]');
    assert.equal(warning, null, "no account changed warning when accounts match");

    const confirmButton = Array.from(document.querySelectorAll("button")).find((btn) =>
      btn.textContent?.includes("Confirm and sign"),
    ) as HTMLButtonElement;
    assert.ok(confirmButton, "confirm button is present");
    assert.equal(confirmButton.disabled, false, "confirm button is enabled");

    await act(() => {
      confirmButton.click();
    });
    assert.equal(confirmed, true, "onConfirm is called on button click");
  });

  test("invalidates confirmation and blocks submit when active account changes", async () => {
    let confirmed = false;
    const originalAccount = "GBBD7223BM5VCEOR2G26KDW6Y4G6ZUNS5U67GZ2BGB26KDW6Y4G6ZUNS";
    const switchedAccount = "GCEOR2G26KDW6Y4G6ZUNS5U67GZ2BGB26KDW6Y4G6ZUNSGBBD7223BM5V";

    await renderPolicyDiffModal({
      expectedAccount: originalAccount,
      currentAccount: switchedAccount,
      onConfirm: () => {
        confirmed = true;
      },
    });

    const warning = document.querySelector('[data-testid="confirmation-account-changed"]');
    assert.ok(warning, "confirmation-account-changed warning is visible");
    assert.match(
      warning.textContent || "",
      /Active account changed during review/i,
      "names the account change issue",
    );
    assert.match(warning.textContent || "", /Recovery:/i, "displays explicit recovery path");

    const confirmButton = Array.from(document.querySelectorAll("button")).find((btn) =>
      btn.textContent?.includes("Confirm and sign"),
    ) as HTMLButtonElement;
    assert.ok(confirmButton, "confirm button is present");
    assert.equal(confirmButton.disabled, true, "confirm button is disabled on account change");

    // Attempting to invoke click on disabled button
    await act(() => {
      confirmButton.click();
    });
    assert.equal(confirmed, false, "submission is blocked and onConfirm is not called");
  });

  test("provides cancel path for recovery", async () => {
    let cancelled = false;
    await renderPolicyDiffModal({
      expectedAccount: "GBBD7223BM5VCEOR2G26KDW6Y4G6ZUNS5U67GZ2BGB26KDW6Y4G6ZUNS",
      currentAccount: "GCEOR2G26KDW6Y4G6ZUNS5U67GZ2BGB26KDW6Y4G6ZUNSGBBD7223BM5V",
      onCancel: () => {
        cancelled = true;
      },
    });

    const cancelButton = Array.from(document.querySelectorAll("button")).find((btn) =>
      btn.textContent?.includes("Cancel"),
    ) as HTMLButtonElement;
    assert.ok(cancelButton, "cancel button is available");

    await act(() => {
      cancelButton.click();
    });
    assert.equal(cancelled, true, "operator can cancel to restart review");
  });
});

import assert from "node:assert/strict";
import { afterEach, before, describe, test } from "node:test";
import { installDom, loadReact } from "./domHarness.ts";
import { WalletPickerModal } from "../../components/WalletBar.tsx";
import { NETWORK } from "../../lib/guard/network.ts";

describe("WalletPickerModal read-only connection preview (#514)", () => {
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

  async function renderModal(
    props: {
      connecting?: boolean;
      onClose?: () => void;
      onChoose?: (provider: any) => void;
    } = {},
  ): Promise<void> {
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(() => {
      root!.render(
        React.createElement(WalletPickerModal, {
          availableProviders: ["freighter", "albedo"],
          currentProvider: null,
          connecting: props.connecting ?? false,
          onClose: props.onClose ?? (() => {}),
          onChoose: props.onChoose ?? (() => {}),
        }),
      );
    });
  }

  test("displays read-only connection preview before wallet access", async () => {
    await renderModal();
    const preview = document.querySelector('[data-testid="connection-preview"]');
    assert.ok(preview, "connection preview banner is present");
    assert.match(
      preview.textContent || "",
      /Read-only connection preview/i,
      "identifies preview as read-only",
    );
    assert.match(
      preview.textContent || "",
      new RegExp(NETWORK.name, "i"),
      "explains active network",
    );
    assert.match(
      preview.textContent || "",
      /public Stellar address/i,
      "explains public address read",
    );
    assert.match(
      preview.textContent || "",
      /No secret keys or signing authority/i,
      "states non-custodial and no signing authority",
    );
  });

  test("keeps observer mode available on cancel", async () => {
    let closed = false;
    await renderModal({
      onClose: () => {
        closed = true;
      },
    });

    const cancelButton = document.querySelector(
      '[data-testid="cancel-wallet-picker"]',
    ) as HTMLButtonElement;
    assert.ok(cancelButton, "cancel button is present");
    assert.match(cancelButton.textContent || "", /Keep observing/i);

    const observerNotice = document.querySelector('[data-testid="observer-mode-note"]');
    assert.ok(observerNotice, "observer mode notice is present");
    assert.match(
      observerNotice.textContent || "",
      /every read on this page works without a wallet/i,
    );

    await act(() => {
      cancelButton.click();
    });
    assert.equal(closed, true, "onClose is called when cancelling");
  });

  test("connecting is user-initiated per provider", async () => {
    let chosenProvider: string | null = null;
    await renderModal({
      onChoose: (p) => {
        chosenProvider = p;
      },
    });

    const buttons = Array.from(document.querySelectorAll("button"));
    const connectFreighter = buttons.find((btn) => btn.textContent?.includes("Connect"));
    assert.ok(connectFreighter, "user-initiated connect button is rendered");

    await act(() => {
      connectFreighter.click();
    });
    assert.equal(chosenProvider, "freighter", "connects only upon operator click");
  });
});

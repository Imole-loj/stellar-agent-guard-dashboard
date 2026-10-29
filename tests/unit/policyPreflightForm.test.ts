/**
 * The policy editor's `validate_policy` preflight (issue #259), driven through
 * the real `PolicyForm`: what the contract says before a wallet is ever prompted
 * decides whether the install can proceed at all.
 *
 * Three verdicts, three behaviours, because the read is additive:
 *  - `Invalid(rule)` blocks the install and shows the rule's own sentence;
 *  - `Valid` proceeds to the diff review exactly as before;
 *  - a read that cannot run (older contract, RPC down) proceeds too — the
 *    on-chain `invalid_config` rejection is the guarantee those clients keep.
 */

import assert from "node:assert/strict";
import { test, before, afterEach } from "node:test";
import type { ContextType, ReactElement } from "react";
import { TransactionBuilder, xdr, type Transaction } from "@stellar/stellar-sdk";
import { installDom, loadReact, sleep, type Act } from "./domHarness.ts";
import { PolicyForm } from "../../components/PolicyForm.tsx";
import { GuardContext, GuardEventsContext } from "../../components/GuardProvider.tsx";
import type { GuardSnapshot } from "../../lib/guard/guardOps.ts";
import { NETWORK } from "../../lib/guard/network.ts";

installDom();

const GUARD = "CAYJZT4XH5SWDXNR7MZJCCUBIDAT2KZDDUTZ7OZQEMKCPJGD4P3X4CU7";
const ADMIN = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWH";

let react: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let act: Act;

before(async () => {
  const loaded = await loadReact();
  react = loaded.react;
  createRoot = loaded.createRoot;
  act = loaded.act;
});

afterEach(() => {
  document.body.innerHTML = "";
});

/** A locally valid draft state: one cap installed, allow-any on. */
function snapshotFor(): GuardSnapshot {
  return {
    guard: GUARD,
    fetchedAt: "2026-10-29T10:00:00.000Z",
    status: {
      ok: true,
      value: {
        has_policy: true,
        admin_frozen: false,
        heartbeat_expired: false,
        last_heartbeat: 1_700_000_000n,
        now: 1_700_000_060n,
      },
    },
    policy: {
      ok: true,
      value: {
        per_tx_cap: 1_000_000n,
        window_cap: 5_000_000n,
        window_secs: 86_400n,
        assets: [],
        recipients: [],
        protocols: [],
        paused: false,
        active_from: 0n,
        active_until: 0n,
        allow_any_recipient: true,
        dms_grace_secs: 0n,
      },
    },
    window: { ok: true, value: null },
    identity: {
      ok: true,
      value: { reportedWasmHash: "abc123", fetchedSha256: "abc123", bytes: 39673, match: true },
    },
  };
}

/** `ValidationOutcome::Invalid(rule)` as the contract sends it over the wire. */
function invalidOutcome(rule: string): xdr.ScVal {
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("Invalid"),
    xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(rule)]),
  ]);
}

const VALID_OUTCOME = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Valid")]);

/** The function a built transaction invokes, so the test can name what was read. */
function invokedFunction(transaction: { toXDR(): string }): string {
  const envelope = TransactionBuilder.fromXDR(
    transaction.toXDR(),
    NETWORK.passphrase,
  ) as Transaction;
  const env = envelope.toEnvelope();
  if (env.type !== "envelopeTypeTx") return "";
  for (const operation of env.v1.tx.operations) {
    const body = operation.body;
    if (body.type !== "invokeHostFunction") continue;
    const hostFunction = body.invokeHostFunctionOp.hostFunction;
    if (hostFunction.type !== "hostFunctionTypeInvokeContract") continue;
    const raw = hostFunction.invokeContract.functionName.bytes;
    return new TextDecoder().decode(
      raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayLike<number>),
    );
  }
  return "";
}

/**
 * A stand-in for the `rpc.Server` in context: it answers `validate_policy`
 * simulations with the verdict under test and records every function read, so
 * the test can assert the preflight happened — and that nothing else did.
 */
function serverFor(verdict: { outcome: xdr.ScVal } | { unreachable: true }) {
  const reads: string[] = [];
  const server = {
    simulateTransaction: async (transaction: { toXDR(): string }) => {
      reads.push(invokedFunction(transaction));
      if ("unreachable" in verdict) throw new Error("the RPC endpoint is unreachable");
      return {
        id: "mock-simulation",
        latestLedger: 1,
        result: { retval: verdict.outcome },
      };
    },
  };
  return { reads, server };
}

type GuardContextValue = NonNullable<ContextType<typeof GuardContext>>;

function contextFor(server: unknown, signerCalls: string[]) {
  return {
    snapshot: snapshotFor(),
    snapshotError: null,
    guard: GUARD,
    server,
    wallet: { address: ADMIN, networkPassphrase: "p", network: "testnet" },
    signer: () => {
      signerCalls.push("signer");
      throw new Error("nothing may reach the wallet before the diff is confirmed");
    },
    refreshing: false,
    refresh: async () => {},
    pushEvents: () => {},
    notifyTabs: () => {},
  };
}

async function renderForm(initial: ReturnType<typeof contextFor>) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = async (value: ReturnType<typeof contextFor>) => {
    await act(async () => {
      root.render(
        react.createElement(
          GuardEventsContext.Provider,
          { value: [] },
          react.createElement(
            GuardContext.Provider,
            { value: value as unknown as GuardContextValue },
            react.createElement(PolicyForm) as ReactElement,
          ),
        ),
      );
    });
    await act(async () => {
      await sleep(10);
    });
  };
  await render(initial);
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
    },
  };
}

function capInput(container: HTMLElement): HTMLInputElement {
  const label = Array.from(container.querySelectorAll("label.field")).find((candidate) =>
    candidate.textContent?.includes("Per-transaction cap"),
  );
  const input = label?.querySelector("input");
  assert.ok(input, "the per-transaction cap input must render");
  return input;
}

async function typeInto(input: HTMLInputElement, text: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, text);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    await sleep(0);
  });
}

function button(container: HTMLElement, text: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  assert.ok(found, `expected a button labelled "${text}"`);
  return found;
}

const diffDialog = () => document.querySelector('[aria-label="Policy changes"]');

const preflightBlock = (container: HTMLElement) =>
  Array.from(container.querySelectorAll(".error")).find((node) =>
    node.textContent?.includes("The guard would reject this policy"),
  ) ?? null;

/** Click "Sign and install policy" and let the preflight settle. */
async function clickInstall(container: HTMLElement): Promise<void> {
  await act(async () => {
    button(container, "Sign and install policy").click();
  });
  await act(async () => {
    await sleep(20);
  });
}

test("a failing preflight blocks the install and shows the failing rule", async () => {
  const s = serverFor({ outcome: invalidOutcome("PerTxCapExceedsWindowCap") });
  const signerCalls: string[] = [];
  const form = await renderForm(contextFor(s.server, signerCalls));
  try {
    await typeInto(capInput(form.container), "42");
    await clickInstall(form.container);

    assert.deepEqual(s.reads, ["validate_policy"], "the draft was preflighted, nothing else");
    const block = preflightBlock(form.container);
    assert.ok(block, "the failing rule is shown in the form");
    const text = block.textContent ?? "";
    assert.match(text, /Per-transaction cap/);
    assert.match(text, /cannot exceed the rolling-window cap/);
    assert.match(text, /Nothing was signed or submitted/);

    assert.equal(
      button(form.container, "Sign and install policy").disabled,
      true,
      "submission stays blocked while the rule fails",
    );
    assert.equal(diffDialog(), null, "no diff review opens, so nothing can be signed");
    assert.deepEqual(signerCalls, [], "the wallet is never prompted");

    // Any edit is a new question: the block clears and the button is live again.
    await typeInto(capInput(form.container), "43");
    assert.equal(preflightBlock(form.container), null, "the stale verdict is dropped on edit");
    assert.equal(button(form.container, "Sign and install policy").disabled, false);
  } finally {
    await form.unmount();
  }
});

test("Valid preflights and opens the diff review exactly as before", async () => {
  const s = serverFor({ outcome: VALID_OUTCOME });
  const signerCalls: string[] = [];
  const form = await renderForm(contextFor(s.server, signerCalls));
  try {
    await typeInto(capInput(form.container), "42");
    await clickInstall(form.container);

    assert.deepEqual(s.reads, ["validate_policy"]);
    assert.equal(preflightBlock(form.container), null, "a valid policy shows no error");
    assert.ok(diffDialog(), "the operator is asked to review the change");
    assert.deepEqual(signerCalls, [], "opening the review does not prompt the wallet");
  } finally {
    await form.unmount();
  }
});

test("a preflight that cannot run does not block the write", async () => {
  // The read is additive: an older contract without `validate_policy`, or a
  // flaky RPC, must leave the write path exactly as it was — `set_policy`'s
  // own on-chain `invalid_config` rejection still guards those clients.
  const s = serverFor({ unreachable: true });
  const signerCalls: string[] = [];
  const form = await renderForm(contextFor(s.server, signerCalls));
  try {
    await typeInto(capInput(form.container), "42");
    await clickInstall(form.container);

    assert.deepEqual(s.reads, ["validate_policy"]);
    assert.equal(preflightBlock(form.container), null, "no verdict, no block");
    assert.ok(diffDialog(), "the install can still proceed to review");
  } finally {
    await form.unmount();
  }
});

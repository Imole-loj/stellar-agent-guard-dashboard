/**
 * The PolicyForm submit pipeline, exercised without a wallet or a network
 * (issue #41).
 *
 * The form's field validation already has unit coverage (`policyForm.test.ts`),
 * but the wiring *after* validation — encode the draft, simulate, sign, broadcast,
 * poll for inclusion, re-read — only ran in the manual `prove:phase3` proof and
 * the browser e2e suite. A regression in that wiring therefore shipped
 * undetected. The injection surface is the one the component already reads: it
 * takes `server` and `signer` from `GuardContext` (`useGuard`), so this test
 * provides a fake context and needs no production-code change and no new
 * dependency.
 *
 * The fake server is deliberately strict: it implements only the calls the
 * pipeline makes, and records their order. That is what makes the four branches
 * assertions about behaviour rather than about mocks:
 *
 *   happy path        encode → simulate → sign → broadcast → poll → re-read
 *   invalid form      zero simulate / zero sign / zero broadcast
 *   wallet decline    signed once, never broadcast, error rendered
 *   broadcast refusal nothing is reported as landed, refusal rendered
 */

import assert from "node:assert/strict";
import { afterEach, before, test } from "node:test";
import { Account, SorobanDataBuilder, rpc, xdr } from "@stellar/stellar-sdk";
import { decodePolicy } from "stellar-agent-guard-sdk";
import type { ReactElement, ReactNode } from "react";
import { installDom, loadReact, sleep, type Act } from "./domHarness.ts";
import { PolicyForm } from "../../components/PolicyForm.tsx";
import {
  GuardContext,
  GuardEventsContext,
  type GuardContextValue,
} from "../../components/GuardProvider.tsx";
import type { GuardSnapshot } from "../../lib/guard/guardOps.ts";
import type { WalletSigner } from "../../lib/guard/submit.ts";
import { WalletUserRejectedError } from "../../lib/guard/walletConnector.ts";
import { NETWORK } from "../../lib/guard/network.ts";
import { decodeInvocation } from "../helpers/identityRace.ts";

installDom();

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
  window.localStorage.clear();
});

const GUARD = "CBLQLJAG72M4XQRJMQHSKYIFVHQD7LNTNOQH2GRMCMBWMSLBSLTGTJC7";
const SIGNER = "GA76DICZHOAA3L2OUCHG4X6J6DMM2NDEPLUWMK4PVLR2YTXZADHJZIXD";
const TOKEN = "CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB";
const RECIPIENT = "GAOBCRXTCO4ZCBNHALJUMJJ5JDXNOUZ7U6VZJX4UBTXAHQEO66IPU6PH";

/**
 * The calls the pipeline makes, in order. `sign` is recorded by the signer, the
 * rest by the fake server, so one array pins the whole sequence.
 */
type Call = "getAccount" | "simulate" | "sign" | "send" | "getTransaction";

interface PipelineServer {
  server: rpc.Server;
  calls: Call[];
  /** The set_policy argument the first simulation carried. */
  policyArgs: () => unknown[];
}

function simulationSuccess() {
  const data = new SorobanDataBuilder()
    .setReadWrite([])
    .setResourceFee(1n)
    .setResources(1_000_000, 0, 0)
    .build();
  return {
    status: "SUCCESS",
    transactionData: data,
    minResourceFee: "1",
    result: { auth: [], retval: xdr.ScVal.scvVoid() },
    events: [],
    latestLedger: 1,
    cost: { cpuInsns: "0", memBytes: "0" },
  };
}

function createPipelineServer(options: { broadcast: "pending" | "error" }): PipelineServer {
  const calls: Call[] = [];
  let firstInvocationArgs: unknown[] = [];
  const server = {
    async getAccount(address: string) {
      calls.push("getAccount");
      return new Account(address, "1");
    },
    async simulateTransaction(tx: unknown) {
      calls.push("simulate");
      if (firstInvocationArgs.length === 0) {
        const envelope = xdr.TransactionEnvelope.fromXDR(
          (tx as { toXDR(): string }).toXDR(),
          "base64",
        );
        // This SDK build exposes union arms as properties (see `decodeInvocation`
        // in the race helper), not as accessor functions.
        const body =
          envelope.type === "envelopeTypeTx" ? envelope.v1.tx.operations[0]?.body : undefined;
        const hostFunction =
          body && body.type === "invokeHostFunction"
            ? body.invokeHostFunctionOp.hostFunction
            : undefined;
        firstInvocationArgs =
          hostFunction && hostFunction.type === "hostFunctionTypeInvokeContract"
            ? (hostFunction.invokeContract.args as unknown[])
            : [];
      }
      return simulationSuccess();
    },
    async sendTransaction() {
      calls.push("send");
      if (options.broadcast === "error") {
        return { status: "ERROR", errorResult: "tx_bad_auth (fixture)", hash: "" };
      }
      return { status: "PENDING", hash: "ab".repeat(32), latestLedger: 1 };
    },
    async getTransaction() {
      calls.push("getTransaction");
      return { status: rpc.Api.GetTransactionStatus.SUCCESS, ledger: 42, events: [] };
    },
  } as unknown as rpc.Server;
  return {
    server,
    calls,
    policyArgs: () => firstInvocationArgs,
  };
}

function createSigner(options: { decline?: boolean; calls: Call[] }): WalletSigner {
  return {
    address: SIGNER,
    async signTransaction(transactionXdr: string) {
      options.calls.push("sign");
      if (options.decline) {
        throw new WalletUserRejectedError("freighter", "sign the transaction");
      }
      return transactionXdr;
    },
    async signAuthEntry() {
      throw new Error("the policy install path does not need an auth-entry signature");
    },
  };
}

function snapshot(): GuardSnapshot {
  return {
    guard: GUARD,
    fetchedAt: new Date().toISOString(),
    status: {
      ok: true,
      value: {
        admin_frozen: false,
        has_policy: true,
        heartbeat_expired: false,
        last_heartbeat: 1n,
        now: 2n,
      },
    },
    policy: { ok: true, value: null },
    window: { ok: true, value: null },
    identity: {
      ok: true,
      value: { reportedWasmHash: null, fetchedSha256: "", bytes: 0, match: false },
    },
  };
}

interface Harness {
  container: HTMLElement;
  fake: PipelineServer;
  refreshes: number;
  unmount: () => Promise<void>;
}

async function renderForm(options: {
  broadcast?: "pending" | "error";
  decline?: boolean;
}): Promise<Harness> {
  const fake = createPipelineServer({ broadcast: options.broadcast ?? "pending" });
  const signer = createSigner({ calls: fake.calls, ...(options.decline ? { decline: true } : {}) });
  const counter = { refreshes: 0 };
  const value = {
    server: fake.server,
    wallet: {
      address: SIGNER,
      networkPassphrase: NETWORK.passphrase,
      network: NETWORK.name,
    },
    signer: () => signer,
    guard: GUARD,
    refresh: async () => {
      counter.refreshes += 1;
    },
    snapshot: snapshot(),
    pushEvents: () => {},
    notifyTabs: () => {},
  } as unknown as GuardContextValue;

  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: ReturnType<typeof createRoot> | undefined;
  const tree = (): ReactElement =>
    react.createElement(
      GuardContext.Provider,
      { value },
      react.createElement(
        GuardEventsContext.Provider,
        { value: [] },
        react.createElement(PolicyForm),
      ),
    );
  await act(async () => {
    root = createRoot(container);
    root.render(tree());
  });
  return {
    container,
    fake,
    get refreshes() {
      return counter.refreshes;
    },
    unmount: async () => {
      await act(async () => {
        root?.unmount();
      });
      container.remove();
    },
  };
}

/** Set a controlled input/textarea the way a user edit does. */
function setField(container: HTMLElement, selector: string, value: string): void {
  const element = container.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement;
  assert.ok(element, `expected a field matching ${selector}`);
  const prototype =
    element instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")!.set!;
  setter.call(element, value);
  element.dispatchEvent(new window.Event("input", { bubbles: true }));
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(label),
  );
  assert.ok(match, `expected a button labelled ${label}`);
  return match as HTMLButtonElement;
}

async function fillValidPolicy(container: HTMLElement): Promise<void> {
  await act(async () => {
    setField(container, 'input[placeholder="1000"]', "1000");
    setField(container, 'input[placeholder="150"]', "5000");
    setField(container, 'input[placeholder="86400"]', "60");
    setField(container, `textarea[placeholder="${TOKEN}"]`, TOKEN);
    setField(container, `textarea[placeholder="${RECIPIENT}"]`, RECIPIENT);
  });
}

async function settle(ms = 60): Promise<void> {
  await act(async () => {
    await sleep(ms);
  });
}

/** Submit a valid form through the review dialog, up to the pipeline settling. */
async function submitValidForm(harness: Harness): Promise<void> {
  await fillValidPolicy(harness.container);
  await settle();
  assert.equal(button(harness.container, "Sign and install policy").disabled, false);
  await act(async () => {
    button(harness.container, "Sign and install policy").click();
  });
  await settle();
  await act(async () => {
    button(harness.container, "Confirm and sign").click();
  });
  await settle(120);
}

test("happy path: encode → simulate → sign → broadcast → poll → re-read", async () => {
  const harness = await renderForm({});
  try {
    await submitValidForm(harness);

    // The exact argument the form encoded, decoded with the contract's own
    // decoder. This is the "encode-called-with-form-state" assertion.
    const policy = decodePolicy(harness.fake.policyArgs()[0] as xdr.ScVal);
    assert.equal(policy.per_tx_cap, 1000n);
    assert.equal(policy.window_cap, 5000n);
    assert.equal(policy.window_secs, 60n);
    assert.deepEqual(policy.assets, [TOKEN]);
    assert.deepEqual(policy.recipients, [RECIPIENT]);

    // Discovery simulation, enforced simulation, wallet signature, broadcast,
    // inclusion poll — in that order, with nothing skipped.
    assert.deepEqual(
      harness.fake.calls.filter((call) => call !== "getAccount"),
      ["simulate", "simulate", "sign", "send", "getTransaction"],
    );
    assert.equal(harness.refreshes, 1, "a landed write re-reads the guard");
    assert.match(harness.container.textContent ?? "", /set_policy landed on chain/);
  } finally {
    await harness.unmount();
  }
});

test("invalid form: zero simulation, zero signature, zero broadcast", async () => {
  const harness = await renderForm({});
  try {
    await act(async () => {
      setField(harness.container, 'input[placeholder="1000"]', "not-a-number");
    });
    await settle();

    assert.match(harness.container.textContent ?? "", /This policy is not valid yet/);
    assert.equal(button(harness.container, "Sign and install policy").disabled, true);

    await act(async () => {
      button(harness.container, "Sign and install policy").click();
    });
    await settle();

    assert.deepEqual(harness.fake.calls, [], "nothing reached the transport");
    assert.equal(harness.refreshes, 0);
  } finally {
    await harness.unmount();
  }
});

test("wallet decline: the transaction is signed but never broadcast", async () => {
  const harness = await renderForm({ decline: true });
  try {
    await submitValidForm(harness);

    assert.equal(
      harness.fake.calls.filter((call) => call === "sign").length,
      1,
      `${harness.fake.calls.join(",")} | ${harness.container.textContent}`,
    );
    assert.equal(harness.fake.calls.filter((call) => call === "send").length, 0);
    assert.equal(harness.fake.calls.filter((call) => call === "getTransaction").length, 0);
    assert.equal(harness.refreshes, 0, "a declined write changes nothing to re-read");
    // The component surfaces the wallet's own message, not a generic failure.
    assert.match(
      harness.container.textContent ?? "",
      /You declined to sign the transaction in Freighter\. Nothing was sent\./,
    );
    assert.equal(
      button(harness.container, "Sign and install policy").disabled,
      false,
      "the form still offers a retry",
    );
  } finally {
    await harness.unmount();
  }
});

test("broadcast refusal: reported as refused, never as landed", async () => {
  const harness = await renderForm({ broadcast: "error" });
  try {
    await submitValidForm(harness);

    assert.equal(
      harness.fake.calls.filter((call) => call === "send").length,
      1,
      `${harness.fake.calls.join(",")} | ${harness.container.textContent}`,
    );
    assert.equal(
      harness.fake.calls.filter((call) => call === "getTransaction").length,
      0,
      harness.fake.calls.join(","),
    );
    // A refusal still re-reads the guard: the operator is looking at a state
    // they just tried to change, and the panel should show what is actually
    // there. It is the *receipt* that must be absent, not the refresh.
    assert.equal(harness.refreshes, 1);
    assert.match(
      harness.container.textContent ?? "",
      /Refused during submission — nothing was broadcast, so this cost nothing/,
    );
    assert.equal(
      (harness.container.textContent ?? "").includes("landed on chain"),
      false,
      "a refusal is not a receipt",
    );
    assert.equal(
      button(harness.container, "Sign and install policy").disabled,
      false,
      "the form still offers a retry",
    );
  } finally {
    await harness.unmount();
  }
});

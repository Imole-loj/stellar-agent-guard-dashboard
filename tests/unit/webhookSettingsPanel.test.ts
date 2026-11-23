import assert from "node:assert/strict";
import { afterEach, before, describe, it } from "node:test";
import type { ContextType } from "react";
import { installDom, loadReact, sleep, type Act } from "./domHarness.ts";
import { WebhookSettingsModal, pingHeadline } from "../../components/WebhookSettings.tsx";
import { GuardContext } from "../../components/GuardProvider.tsx";
import {
  WEBHOOK_SETTINGS_STORAGE_KEY,
  buildWebhookPayload,
  type DispatchOutcome,
  type DispatchResult,
} from "../../lib/guard/webhookDispatcher.ts";

/**
 * The webhook dialog's test send, as the operator reads it (#315).
 *
 * The dispatcher already proves which outcome a failure classifies to; what only
 * the dialog can get wrong is the sentence written above it. Every failure here
 * renders through the same banner, and before the outcomes were separated that
 * banner said "was not delivered" about a request that might have arrived — the
 * one reading an operator would act on.
 *
 * Lives under `tests/unit` because that is the directory `npm test` runs.
 */

installDom();

type GuardContextValue = NonNullable<ContextType<typeof GuardContext>>;

const GUARD = "CAYJZT4XH5SWDXNR7MZJCCUBIDAT2KZDDUTZ7OZQEMKCPJGD4P3X4CU7";
const URL = "https://hooks.example.com/guard";

let react: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let act: Act;

before(async () => {
  const loaded = await loadReact();
  react = loaded.react;
  createRoot = loaded.createRoot;
  act = loaded.act;
});

const realFetch = globalThis.fetch;

afterEach(() => {
  document.body.innerHTML = "";
  window.localStorage.clear();
  globalThis.fetch = realFetch;
});

/** A `fetch` that behaves like a browser's, given per-method answers. */
function installFetch(answer: (url: string, init: RequestInit) => { status: number } | Error): {
  posts: string[];
  probes: number;
} {
  const record = { posts: [] as string[], probes: 0 };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const options = init ?? {};
    const method = options.method ?? "GET";
    if (method === "GET") record.probes += 1;
    else record.posts.push(String(options.body ?? ""));
    const outcome = answer(String(input), options);
    if (outcome instanceof Error) throw outcome;
    return { status: outcome.status, ok: outcome.status < 300 } as Response;
  }) as unknown as typeof fetch;
  return record;
}

async function mountDialog() {
  window.localStorage.setItem(
    WEBHOOK_SETTINGS_STORAGE_KEY,
    JSON.stringify({ enabled: true, url: URL, secret: "", minIntervalMs: 60_000 }),
  );
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const value = { guard: GUARD } as unknown as GuardContextValue;

  await act(async () => {
    root.render(
      react.createElement(
        GuardContext.Provider,
        { value },
        react.createElement(WebhookSettingsModal, { onClose: () => {} }),
      ),
    );
  });
  await act(async () => {
    await sleep(0);
  });

  async function testWebhook() {
    const button = Array.from(container.querySelectorAll("button")).find((entry) =>
      /^Test webhook$/.test((entry.textContent ?? "").trim()),
    );
    assert.ok(button, "the dialog offers a Test webhook button");
    // The send awaits a fetch and then a state update, so the click needs the
    // whole microtask queue drained inside act, not one tick.
    await act(async () => {
      button.click();
      await sleep(0);
      await sleep(0);
    });
  }

  function banner(): string {
    return container.querySelector('[data-testid="webhook-test-result"]')?.textContent ?? "";
  }

  return { container, testWebhook, banner };
}

describe("the test-send banner", () => {
  it("says delivered, and nothing more, when the endpoint answers 2xx", async () => {
    installFetch(() => ({ status: 200 }));
    const dialog = await mountDialog();
    await dialog.testWebhook();
    assert.match(dialog.banner(), /^Test webhook delivered/);
    assert.doesNotMatch(dialog.banner(), /not delivered|unknown/i);
  });

  it("names a refused endpoint as a refusal, with the status", async () => {
    installFetch(() => ({ status: 503 }));
    const dialog = await mountDialog();
    await dialog.testWebhook();
    assert.match(dialog.banner(), /was not delivered/);
    assert.match(dialog.banner(), /503/);
  });

  it("blames the address when nothing at that host answers", async () => {
    // Both the POST and the reachability probe throw: the same browser error the
    // CORS case produces, and the only difference an operator can see is here.
    installFetch(() => new TypeError("Failed to fetch"));
    const dialog = await mountDialog();
    await dialog.testWebhook();
    assert.match(dialog.banner(), /never reached the host/);
    assert.doesNotMatch(dialog.banner(), /origin/i);
  });

  it("blames the origin when the host answers but will not accept the page", async () => {
    installFetch((_url, init) =>
      (init.method ?? "GET") === "GET" ? { status: 200 } : new TypeError("Failed to fetch"),
    );
    const dialog = await mountDialog();
    await dialog.testWebhook();
    assert.match(dialog.banner(), /origin/i);
    // The distinction is only worth having if the two cases do not print the
    // same sentence for two different fixes.
    assert.doesNotMatch(dialog.banner(), /never reached the host/);
  });
});

describe("the test-send headline never claims more than the outcome knows (#315)", () => {
  const payload = buildWebhookPayload({
    event: "FREEZE_ACTIVATED",
    guard: GUARD,
    network: "testnet",
    timestamp: "2026-10-03T12:00:00.000Z",
  });
  const result = (outcome: DispatchOutcome): DispatchResult => ({
    ok: outcome === "sent",
    outcome,
    status: null,
    error: null,
    payload,
  });

  it("reports a timeout as unknown rather than as a delivery that failed", () => {
    const headline = pingHeadline(result("timeout"));
    assert.match(headline, /unknown/i);
    // A timeout is the response going missing, not the request. A security
    // operator told "was not delivered" would rebuild an endpoint that may
    // already be receiving alerts.
    assert.doesNotMatch(headline, /not delivered/i);
  });

  it("reserves the delivered claim for a real delivery", () => {
    assert.equal(pingHeadline(result("sent")), "Test webhook delivered");
    for (const outcome of ["timeout", "cors", "network", "failed", "rejected"] as const) {
      assert.doesNotMatch(pingHeadline(result(outcome)), /^Test webhook delivered$/);
    }
  });
});

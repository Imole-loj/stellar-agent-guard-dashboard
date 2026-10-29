/**
 * The artifact pin stops a deploy before the wallet is asked to sign (issue
 * #351).
 *
 * The hash helper itself is unit-tested; what only a browser can pin is the
 * thing a unit test cannot see — that the *panel* refuses. A regression that
 * moved the wallet prompt earlier in the flow would leave every hash assertion
 * green and still get a signature for bytecode nobody reviewed, so these specs
 * assert three things together: the mismatch is visible, the deploy control is
 * inert, and the wallet mock never receives a signing request.
 *
 * Two mismatch shapes are stubbed as separate cases — bytes with the wrong
 * hash, and bytes of the wrong length — because they fail different halves of
 * `checkArtifact` (`hashMatch` and `sizeMatch`). The third case proves the
 * recovery half: once the chain serves the genuine fixture again, a re-check
 * re-enables deploy without reloading the page.
 */

import { expect, test, type Page } from "@playwright/test";
import { installSorobanRpcMock } from "./sorobanRpcMock.ts";
import type { ArtifactMode, SorobanRpcMock } from "./sorobanRpcMock.ts";
import { installFreighterMock, signRequestCount } from "./walletMock.ts";
import { PHASE1_ARTIFACT } from "../../lib/guard/network.ts";

/** Pinned byte length plus the eight bytes the length-mismatch case appends. */
const MISMATCHED_LENGTH = PHASE1_ARTIFACT.wasmBytes + 8;
const PINNED_PREFIX = PHASE1_ARTIFACT.wasmHash.slice(0, 16);

/**
 * Install the mock chain for one artifact mode, connect the mocked wallet, and
 * land on the deploy step — the state every case starts from: a connected
 * operator looking at a gate that has already rendered its verdict.
 */
async function openDeploy(page: Page, artifact: ArtifactMode): Promise<SorobanRpcMock> {
  const chain = await installSorobanRpcMock(page, { artifact });
  await installFreighterMock(page);
  await page.goto("/deploy");

  const connected = page.locator(".pill.ok").filter({ hasText: "connected" });
  try {
    await connected.waitFor({ state: "visible", timeout: 5_000 });
  } catch {
    await page.getByRole("button", { name: "Connect admin wallet" }).click();
    const picker = page.getByRole("dialog", { name: "Choose a wallet provider" });
    await expect(picker.getByText("detected", { exact: true })).toBeVisible();
    await picker.getByRole("button", { name: "Connect", exact: true }).click();
    await connected.waitFor({ state: "visible" });
  }
  return chain;
}

/**
 * The three assertions every mismatch case owes: visible, inert, unprompted.
 *
 * The sign counter is the point of the trio — a disabled-looking button that
 * still reaches the extension would pass a visibility assertion and fail here.
 */
async function expectRefusedBeforeSigning(page: Page): Promise<void> {
  const identity = page.locator(".stat", { hasText: "Identity" });
  await expect(identity.locator(".v")).toHaveText("MISMATCH");
  await expect(identity.locator(".n")).toHaveText("deploy is refused");
  await expect(page.getByText("Deploy refused")).toBeVisible();
  await expect(page.getByRole("button", { name: "Deploy guard" })).toBeDisabled();
  expect(await signRequestCount(page)).toBe(0);
}

test.describe("deploy is refused when the artifact pin does not match", () => {
  test("a mismatched artifact hash stops the deploy before any signature", async ({ page }) => {
    await openDeploy(page, "hash-mismatch");

    // Same length as the pin, different bytes: only the hash half can catch
    // this one, and the panel must say which artifact it actually fetched.
    const fetched = page.locator(".stat", { hasText: "Fetched from chain" });
    await expect(fetched.locator(".n")).toHaveText(`${PHASE1_ARTIFACT.wasmBytes} bytes`);
    await expect(fetched.locator(".v")).not.toHaveText(`${PINNED_PREFIX}...`);

    await expectRefusedBeforeSigning(page);
  });

  test("a mismatched byte length stops the deploy before any signature", async ({ page }) => {
    await openDeploy(page, "length-mismatch");

    // Longer than the pinned module, so the size half fails even if a hash
    // comparison were ever skipped.
    const fetched = page.locator(".stat", { hasText: "Fetched from chain" });
    await expect(fetched.locator(".n")).toHaveText(`${MISMATCHED_LENGTH} bytes`);

    await expectRefusedBeforeSigning(page);
  });

  test("a valid artifact afterwards re-enables deploy without a reload", async ({ page }) => {
    const chain = await openDeploy(page, "length-mismatch");
    await expectRefusedBeforeSigning(page);

    // The provider serves the genuine fixture again. The operator's way back is
    // the re-check button — no reload, no lost form state, no wallet prompt in
    // between.
    chain.artifactMode = "pinned";
    await page.getByRole("button", { name: "Re-check artifact" }).click();

    const identity = page.locator(".stat", { hasText: "Identity" });
    await expect(identity.locator(".v")).toHaveText("matches");
    await expect(identity.locator(".n")).toHaveText("deploy is permitted");
    await expect(page.getByRole("button", { name: "Deploy guard" })).toBeEnabled();
    expect(await signRequestCount(page)).toBe(0);
  });
});

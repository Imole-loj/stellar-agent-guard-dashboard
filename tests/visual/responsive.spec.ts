import { expect, test } from "@playwright/test";

/**
 * Responsive-regression baselines (issue #39, follow-up to the #35 audit).
 *
 * The #35 audit promised a 375px check of `/configure` but could only record it
 * as a manual screenshot in the PR: jsdom has no layout engine, so
 * `tests/unit/responsiveContract.test.ts` can assert the stylesheet/class
 * wiring but not what the page actually looks like. These three captures turn
 * that manual promise into a check that runs on every pull request:
 *
 *   `/configure` at 375×667 — the narrow form layout on the audit's device size
 *   `/configure` at 1280×800 — the same screen at the desktop review size
 *   `/` at 1280×800          — the operator console at the desktop review size
 *
 * They deliberately capture the *viewport*, not the full page: the image is
 * exactly the size named above, so a baseline diff is a layout change at that
 * device size rather than a change to some arbitrary scroll length. The
 * full-page suite in `dashboardVisual.spec.ts` already guards the content below
 * the fold at 375px width; this file guards what an operator sees first at the
 * sizes the responsive issue named.
 *
 * ## Why these snapshots are stable
 *
 * Every read is pinned to a failure instead of live chain data, exactly as in
 * the main visual suite: the console is a pure Soroban RPC consumer, and a
 * balance or rolling-window total changes between runs. Aborting the RPC host
 * also exercises the state this interface is most careful about — a failed read
 * must render as a reported failure, never as a fabricated zero. The capture
 * waits for that failure copy and for `document.fonts.ready`, so it can never
 * bake in a half-rendered loading frame or a font swap.
 *
 * ## Baseline provenance (anti-drift rule)
 *
 * Snapshots are regenerated **only** inside the Playwright container image in
 * `.github/workflows/visual-tests.yml` — the `update-screenshots` job, which
 * runs when a commit message contains `update-screenshots`. It builds the app,
 * runs `--update-snapshots` in the pinned image (browser build *and* fonts) and
 * pushes the refreshed files back to the branch. Do not regenerate them with
 * `npm run test:visual:update` on a developer machine and commit the result:
 * a local macOS/Windows font stack produces different antialiasing, and the
 * next CI run would diff against pixels it can never reproduce. The tolerance
 * that absorbs the remaining renderer variance is documented once, beside the
 * assertion config in `playwright.visual.config.ts`.
 */

/** The app's only external dependency: the Soroban RPC endpoint. */
const SOROBAN_RPC = /soroban-testnet\.stellar\.org/;

/**
 * Copy that proves the page has settled. Both screens report a failed read
 * rather than inventing a value, which is deterministic with the RPC blocked.
 */
const SETTLED: Record<string, string> = {
  "/": "status(): read failed",
  "/configure": "unreadable",
};

/**
 * Time-derived copy, masked rather than frozen so the rest of the page is still
 * rendered by the real application.
 */
const TIME_COPY = [/^read (just now|\d+[smhd])$/];

async function settledScreen(page: import("@playwright/test").Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(page.getByText(SETTLED[path]!).first()).toBeVisible();
  // A capture before the fonts settle would bake a half-loaded frame into the
  // baseline. The promise resolves once layout can no longer change from a
  // font swap.
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
}

test.beforeEach(async ({ page }) => {
  // A baseline must never depend on the live network.
  await page.route(SOROBAN_RPC, (route) => route.abort());
});

// `@mobile` / `@desktop` are the project-level selectors in
// playwright.visual.config.ts, so each capture runs in exactly one project and
// produces exactly one snapshot file.
test("configure at 375x667 matches its baseline @mobile", async ({ page }) => {
  await settledScreen(page, "/configure");
  await expect(page).toHaveScreenshot("configure-375x667.png");
});

test("configure at 1280x800 matches its baseline @desktop", async ({ page }) => {
  await settledScreen(page, "/configure");
  await expect(page).toHaveScreenshot("configure-1280x800.png");
});

test("console at 1280x800 matches its baseline @desktop", async ({ page }) => {
  await settledScreen(page, "/");
  await expect(page).toHaveScreenshot("console-1280x800.png", {
    mask: TIME_COPY.map((pattern) => page.getByText(pattern)),
  });
});

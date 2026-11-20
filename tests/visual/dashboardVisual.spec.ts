import { expect, test } from "@playwright/test";

/**
 * Visual regression baselines for the operator console.
 *
 * Two properties make these snapshots meaningful rather than decorative:
 *
 *   1. Every read the console performs is pinned to a failure, not to live chain
 *      data. The dashboard is a pure consumer of Soroban RPC, and testnet is a
 *      moving target: a balance, a rolling-window total and a dead-man countdown
 *      all change between runs, so a baseline taken against them would fail for
 *      reasons that have nothing to do with the layout. Blocking the RPC host also
 *      exercises the state this interface is most careful about — a read that did
 *      not succeed must render as a reported failure, never as a fabricated zero.
 *   2. The captured state is awaited explicitly (the panel that reports the failed
 *      read), so a screenshot can never catch a half-rendered loading frame. The
 *      dashboard's own copy is used as the wait condition, which means the test
 *      fails loudly if the failure is ever silently swallowed.
 *
 * The issue that specified this suite named four routes — `/`, `/configure`,
 * `/deploy` and `/panic`. The application has two: `/` composes the console
 * overview and the panic panel, and `/configure` composes guard deployment and
 * the policy form. The suite follows the application rather than inventing routes
 * to match the wording, so all four surfaces are covered by the two screens below.
 */

/** The app's only external dependency: the Soroban RPC endpoint. */
const SOROBAN_RPC = /soroban-testnet\.stellar\.org/;

interface Screen {
  name: string;
  path: string;
  /** Copy the page renders once its reads have settled; the wait condition. */
  settled: string;
  /** Locators whose text is time-derived and therefore not part of the layout. */
  mask: RegExp[];
}

const SCREENS: Screen[] = [
  {
    name: "console",
    path: "/",
    // Every read on this page fails, and `Read` renders each failure in place; a
    // successful read is never faked. Waiting for one of those failure labels
    // means the capture happens after the page settles, not during loading.
    settled: "status(): read failed",
    // The single piece of time-derived copy in the interface. Refreshing rewrites
    // `fetchedAt`, so this label reads "0s ago" one moment and "3s ago" the next.
    // It is masked rather than frozen so the rest of the page is still rendered by
    // the real application, not by a stopped clock.
    mask: [/^read (just now|\d+[smhd])$/],
  },
  {
    name: "configure",
    path: "/configure",
    // `DeployPanel`'s artifact check is the same shape: it names the failure
    // rather than showing an artifact it could not verify.
    settled: "unreadable",
    mask: [],
  },
];

test.beforeEach(async ({ page }) => {
  // A visual baseline must never depend on the live network. Aborting the RPC
  // host keeps the console's own failure handling on screen, which is both
  // deterministic and a state the interface is required to get right.
  await page.route(SOROBAN_RPC, (route) => route.abort());
});

for (const screen of SCREENS) {
  test(`${screen.name} (${screen.path}) matches its baseline`, async ({ page }) => {
    await page.goto(screen.path);
    // `.first()`: `status()` is read for several fields, so its failure label
    // legitimately appears more than once and any one of them proves the page has
    // settled.
    await expect(page.getByText(screen.settled).first()).toBeVisible();

    // Capturing before the fonts settle would bake a half-loaded frame into the
    // baseline. `document.fonts.ready` resolves once layout can no longer change
    // because of a font swap.
    await page.evaluate(async () => {
      await document.fonts.ready;
    });

    // Playwright's `animations: "disabled"` fast-forwards finite animations on
    // the first capture. On the console that settles a 7px layout difference
    // *after* the first screenshot, so the first capture and the comparison
    // would disagree on page height and the assertion would keep retrying until
    // it timed out. One throwaway capture puts the page in the same settled
    // state the committed baseline records; the assertion itself still captures
    // a fresh full page.
    await page.screenshot({ fullPage: true, animations: "disabled" });

    // A full-page capture rather than a viewport one: the panels below the fold
    // (the panic flow, the policy form) are exactly where a layout regression
    // would otherwise go unnoticed.
    await expect(page).toHaveScreenshot(`${screen.name}.png`, {
      fullPage: true,
      mask: screen.mask.map((pattern) => page.getByText(pattern)),
    });
  });
}

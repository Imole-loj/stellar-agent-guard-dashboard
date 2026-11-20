import { defineConfig, devices } from "@playwright/test";

/**
 * Visual regression configuration for the operator console.
 *
 * Every screen is captured at the three viewports the interface is designed for
 * (desktop 1440, tablet 768, mobile 375), in each colour scheme the browser can
 * report (dark and light). The console picks its initial theme from
 * `prefers-color-scheme` unless the operator has already chosen one, so
 * `colorScheme` emulation drives the application's real dark and light palettes
 * rather than a mock. The third theme, high-contrast, is reachable only through
 * the in-app toggle, so colour-scheme emulation cannot select it and it is not
 * covered here.
 *
 * The 375×667 and 1280×800 responsive captures (issue #39) use the two
 * `responsive-*` projects below instead of the 1440/768/375×812 set. They are
 * viewport-sized captures, one project per device size, so those three
 * baselines exist exactly once (`tests/visual/responsive.spec.ts`).
 *
 * ## Baseline provenance
 *
 * Baselines are committed artifacts generated **only** in CI, inside the pinned
 * `mcr.microsoft.com/playwright:v1.64.0-noble` container (see the
 * `update-screenshots` job in `.github/workflows/visual-tests.yml`). The image
 * fixes both the browser build and the font set, so a diff means the interface
 * changed. Regenerating locally with `npm run test:visual:update` uses the
 * developer's fonts and produces exactly the cross-OS drift these comparisons
 * are meant to catch, therefore local `--update-snapshots` results must not be
 * committed. To refresh them, push a commit whose message contains
 * `update-screenshots`; the CI job rebuilds, regenerates and commits the
 * snapshots inside the image.
 */

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "mobile", width: 375, height: 812 },
] as const;

const COLOR_SCHEMES = ["dark", "light"] as const;

/** Files whose captures run in the dedicated responsive projects, not here. */
const RESPONSIVE_SPEC = /responsive\.spec\.ts/;

export default defineConfig({
  testDir: "./tests/visual",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  // A regression run that flakes teaches the team to ignore it, so CI gets one
  // retry and nothing more; a genuine diff survives a retry.
  retries: process.env.CI ? 1 : 0,
  ...(process.env.CI ? { workers: 1 } : {}),
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never" }]]
    : [["list"], ["html", { open: "never" }]],

  // The project name is part of the snapshot path, so a desktop baseline can
  // never be compared against a mobile one by accident.
  snapshotPathTemplate: "{testDir}/__screenshots__/{testFileName}/{arg}-{projectName}{ext}",

  expect: {
    toHaveScreenshot: {
      // Less than 0.5% of pixels may differ. That headroom is for font
      // antialiasing, which is never bit-identical between runs; anything
      // structural — a shifted panel, a changed colour, a wrapped label — is far
      // larger than half a percent. Playwright compares the per-pixel colour
      // distance against `threshold` (the default 0.2, kept) and then allows
      // this fraction of pixels to fall outside it; the ratio is what survives
      // antialiasing across the CI image's font set, while a one-pixel layout
      // shift in a panel or action bar stays well above it.
      maxDiffPixelRatio: 0.005,
      animations: "disabled",
      caret: "hide",
    },
  },

  use: {
    baseURL: "http://127.0.0.1:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },

  projects: [
    ...VIEWPORTS.flatMap((viewport) =>
      COLOR_SCHEMES.map((colorScheme) => ({
        name: `${viewport.name}-${colorScheme}`,
        // The responsive captures have their own two projects below; running
        // them here too would demand six snapshots for three device sizes.
        testIgnore: RESPONSIVE_SPEC,
        use: {
          ...devices["Desktop Chrome"],
          viewport: { width: viewport.width, height: viewport.height },
          colorScheme,
        },
      })),
    ),
    {
      name: "responsive-mobile-375x667",
      testMatch: RESPONSIVE_SPEC,
      grep: /@mobile/,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 375, height: 667 },
        // One theme per size keeps the issue's "three baselines" literal; the
        // light/dark pair is already covered at 375 width by the mobile-light
        // and mobile-dark projects above.
        colorScheme: "dark",
      },
    },
    {
      name: "responsive-desktop-1280x800",
      testMatch: RESPONSIVE_SPEC,
      grep: /@desktop/,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 800 },
        colorScheme: "dark",
      },
    },
  ],

  webServer: {
    // The suite runs against the production build, never the dev server: the dev
    // server injects its own overlay, which is not part of the shipped interface.
    // CI builds first; locally, run `npm run build` before `npm run test:visual`.
    command: "npm run start",
    url: "http://127.0.0.1:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});

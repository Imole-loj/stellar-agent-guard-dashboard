/**
 * Storage keys for preferences that only change how the console looks.
 *
 * These live here rather than beside the code that reads them because
 * `lib/guard/storage.ts` — the reset machinery — has to list them, and it sits
 * inside the `chain → guardOps → fleet → storage` import loop. Importing a key
 * from a module on that loop makes the loop a real cycle at evaluation time: the
 * constant is read by a top-level `const` in `storage.ts` before the other
 * module's body has run, and the bundle dies with a TDZ error instead of a
 * type error. A leaf holding only strings cannot close a loop.
 *
 * Adding a key here is only correct when the module that owns it is otherwise
 * unreachable from `storage.ts`. Behaviour-bearing keys stay where they are.
 */
export const THEME_STORAGE_KEY = "theme";
export const SIDEBAR_COLLAPSED_STORAGE_KEY = "sidebar-collapsed";

/** Storage key for the remembered fleet view. Versioned so a shape change cannot be misread. */
export const FLEET_VIEW_STORAGE_KEY = "stellar-agent-guard-dashboard.fleet-view.v1";

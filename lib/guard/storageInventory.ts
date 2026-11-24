import { ADDRESS_BOOK_STORAGE_KEY } from "./addressBook.ts";
import { ALERT_SETTINGS_STORAGE_KEY } from "./audioAlert.ts";
import { BYTECODE_CACHE_STORAGE_KEY } from "./bytecodeCache.ts";
import { DENSITY_STORAGE_KEY } from "./densityStore.ts";
import { SCOPED_STORAGE_BASES, SCOPED_STORAGE_PREFIX } from "./guardScoped.ts";
import { INSTANCE_STORAGE_PREFIX, LEGACY_INSTANCE_STORAGE_KEY } from "./instance.ts";
import { LAYOUT_STORAGE_KEY, NAMED_LAYOUTS_STORAGE_KEY } from "./layoutStore.ts";
import { SETUP_STORAGE_KEY } from "./setupChecklist.ts";
import { TAB_SYNC_STORAGE_KEY } from "./tabSync.ts";
import { TX_HISTORY_STORAGE_KEY } from "./txHistory.ts";
import { PRIVACY_MASK_STORAGE_KEY } from "./privacyStore.ts";
import { IDLE_TIMEOUT_STORAGE_KEY } from "./useIdleTimer.ts";
import { PREFERRED_WALLET_STORAGE_KEY } from "./walletConnector.ts";
import { WEBHOOK_SETTINGS_STORAGE_KEY } from "./webhookDispatcher.ts";
import {
  FLEET_VIEW_STORAGE_KEY,
  SIDEBAR_COLLAPSED_STORAGE_KEY,
  THEME_STORAGE_KEY,
} from "./presentationStorageKeys.ts";

export type StorageDataCategory = "chain-derived" | "user-entered" | "presentation-only";

export interface StorageInventoryEntry {
  key: string;
  area: "localStorage" | "sessionStorage";
  purpose: string;
  category: StorageDataCategory;
  containsPublicMetadata: boolean;
}

export const STORAGE_INVENTORY: readonly StorageInventoryEntry[] = [
  {
    key: `${INSTANCE_STORAGE_PREFIX}.{network}`,
    area: "localStorage",
    purpose: "Saved public guard addresses and labels",
    category: "user-entered",
    containsPublicMetadata: true,
  },
  {
    key: LEGACY_INSTANCE_STORAGE_KEY,
    area: "localStorage",
    purpose: "Pre-migration saved public guard addresses and labels",
    category: "user-entered",
    containsPublicMetadata: true,
  },
  {
    key: ADDRESS_BOOK_STORAGE_KEY,
    area: "localStorage",
    purpose: "Contact labels and public Stellar addresses",
    category: "user-entered",
    containsPublicMetadata: true,
  },
  {
    key: TX_HISTORY_STORAGE_KEY,
    area: "localStorage",
    purpose: "Transaction hashes, operations, outcomes, and fees recorded by this browser",
    category: "chain-derived",
    containsPublicMetadata: true,
  },
  {
    key: LAYOUT_STORAGE_KEY,
    area: "localStorage",
    purpose: "Dashboard panel order and collapsed state",
    category: "presentation-only",
    containsPublicMetadata: false,
  },
  {
    key: NAMED_LAYOUTS_STORAGE_KEY,
    area: "localStorage",
    purpose: "Named dashboard panel arrangements",
    category: "presentation-only",
    containsPublicMetadata: false,
  },
  {
    key: FLEET_VIEW_STORAGE_KEY,
    area: "localStorage",
    purpose: "Fleet table search, filter, and sort preferences",
    category: "presentation-only",
    containsPublicMetadata: false,
  },
  {
    key: IDLE_TIMEOUT_STORAGE_KEY,
    area: "localStorage",
    purpose: "Configured idle-lock duration",
    category: "presentation-only",
    containsPublicMetadata: false,
  },
  {
    key: ALERT_SETTINGS_STORAGE_KEY,
    area: "localStorage",
    purpose: "Local sound and notification preferences",
    category: "presentation-only",
    containsPublicMetadata: false,
  },
  {
    key: PREFERRED_WALLET_STORAGE_KEY,
    area: "localStorage",
    purpose: "Preferred wallet connector identifier",
    category: "presentation-only",
    containsPublicMetadata: false,
  },
  {
    key: SETUP_STORAGE_KEY,
    area: "localStorage",
    purpose: "Setup checklist progress",
    category: "presentation-only",
    containsPublicMetadata: false,
  },
  {
    key: `${SCOPED_STORAGE_PREFIX}.{base}.{network}.{guard}`,
    area: "localStorage",
    purpose: `Per-guard drafts, filters and event marks (${SCOPED_STORAGE_BASES.join(", ")})`,
    category: "user-entered",
    containsPublicMetadata: true,
  },
  {
    key: WEBHOOK_SETTINGS_STORAGE_KEY,
    area: "localStorage",
    purpose: "Webhook destination and event preferences",
    category: "user-entered",
    containsPublicMetadata: true,
  },
  {
    key: TAB_SYNC_STORAGE_KEY,
    area: "localStorage",
    purpose: "Short-lived cross-tab event transport when BroadcastChannel is unavailable",
    category: "chain-derived",
    containsPublicMetadata: true,
  },
  {
    key: THEME_STORAGE_KEY,
    area: "localStorage",
    purpose: "Color theme preference",
    category: "presentation-only",
    containsPublicMetadata: false,
  },
  {
    key: SIDEBAR_COLLAPSED_STORAGE_KEY,
    area: "localStorage",
    purpose: "Sidebar presentation state",
    category: "presentation-only",
    containsPublicMetadata: false,
  },
  {
    key: DENSITY_STORAGE_KEY,
    area: "localStorage",
    purpose: "Display density preference",
    category: "presentation-only",
    containsPublicMetadata: false,
  },
  {
    key: PRIVACY_MASK_STORAGE_KEY,
    area: "localStorage",
    purpose: "Opt-in masking of public values on screen",
    category: "presentation-only",
    containsPublicMetadata: false,
  },
  {
    key: BYTECODE_CACHE_STORAGE_KEY,
    area: "sessionStorage",
    purpose: "Session-only bytecode hash cache",
    category: "chain-derived",
    containsPublicMetadata: false,
  },
];

/**
 * The inventory's own wording for a concrete key.
 *
 * One table, one set of words: wherever the console names a stored key — the
 * privacy panel, and the reset preview that appears before a destructive button
 * (issue #529) — it reads them from here, so the disclosure and the promise made
 * at the point of no return cannot describe the same key two ways.
 *
 * Templated rows (`…instances.v2.{network}`) cover every concrete key the
 * registry reset walks, so the lookup splits on the placeholder rather than
 * requiring an exact match. A key the inventory has never heard of is returned
 * raw: an undiscovered preference still has to appear in the preview, just less
 * kindly — and the test that every resettable key is disclosed fails first.
 */
export function describeStorageKey(key: string): string {
  const exact = STORAGE_INVENTORY.find((entry) => entry.key === key);
  if (exact) return exact.purpose;
  const pattern = STORAGE_INVENTORY.find((entry) => {
    const literal = entry.key.split(".{")[0];
    return entry.key !== literal && key.startsWith(literal ?? "");
  });
  return pattern?.purpose ?? key;
}

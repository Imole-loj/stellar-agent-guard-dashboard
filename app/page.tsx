"use client";

import { useEffect, useRef } from "react";
import { SubmitSignedXDRPanel } from "../components/SubmitSignedXDRPanel.tsx";
import { GuardProvider } from "../components/GuardProvider.tsx";
import { WalletBar } from "../components/WalletBar.tsx";
import { StatusPanel } from "../components/StatusPanel.tsx";
import { TxHistoryTable } from "../components/TxHistoryTable.tsx";
import { TelemetryFeed } from "../components/TelemetryFeed.tsx";
import { MultisigTracker } from "../components/MultisigTracker.tsx";
import { PanicPanel } from "../components/PanicPanel.tsx";
import { IncidentPanel } from "../components/IncidentPanel.tsx";
import { HardwareWalletGuide } from "../components/HardwareWalletGuide.tsx";
import { DashboardGrid, type GridPanel } from "../components/DashboardGrid.tsx";
import { ScopeNotice } from "../components/bits.tsx";
import { decodeUrlState, routeForTab } from "../lib/guard/urlState.ts";
import { announce } from "../lib/guard/useAnnounce.ts";

/**
 * The console's panels, in the default order. The operator can reorder,
 * collapse and reset these from the grid; `DashboardGrid` owns the
 * arrangement and its persistence.
 */
const PANELS: GridPanel[] = [
  { id: "status", title: "On-chain state", content: <StatusPanel /> },
  { id: "txhistory", title: "Transaction history", content: <TxHistoryTable /> },
  { id: "panic", title: "Emergency", content: <PanicPanel /> },
  // Directly after Emergency because it hands off to it: its freeze and unfreeze
  // rows move focus to the controls above rather than repeating them (#527).
  { id: "incident", title: "Incident actions", content: <IncidentPanel /> },
  { id: "telemetry", title: "Telemetry", content: <TelemetryFeed /> },
  { id: "multisig", title: "Multisig approvals", content: <MultisigTracker /> },
  { id: "xdr", title: "Submit Signed XDR", content: <SubmitSignedXDRPanel /> },
];

/**
 * Adopt the console panel a shared link named (issue #132).
 *
 * A `?tab=telemetry` link is a teammate saying "look at this panel" — so the
 * panel's heading is scrolled into view, focused (the heading takes a
 * programmatic focus only for this restore), and the restoration is announced
 * politely for screen readers. Screen tabs (`?tab=fleet` and friends) are not
 * this page's concern: `GuardProvider` navigates to their route.
 *
 * The read happens after mount — the same hydration rule the console's guard
 * deep-link follows — and runs once, so React StrictMode's double-invoked
 * effects cannot re-focus (or re-announce) a panel the operator has already
 * scrolled away from.
 */
function useRestoreSharedPanelTab(): void {
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    const { tab } = decodeUrlState(window.location.search);
    if (tab === undefined || routeForTab(tab) !== null) return;
    const heading = document.getElementById(`panel-title-${tab}`);
    if (!heading) return;
    heading.setAttribute("tabindex", "-1");
    heading.scrollIntoView({ block: "nearest" });
    heading.focus({ preventScroll: true });
    announce(`Shared view restored — ${tab} panel in view.`);
  }, []);
}

export default function ConsolePage() {
  useRestoreSharedPanelTab();
  return (
    <GuardProvider>
      <HardwareWalletGuide />
      <WalletBar />
      <DashboardGrid panels={PANELS} />
      <ScopeNotice compact />
    </GuardProvider>
  );
}

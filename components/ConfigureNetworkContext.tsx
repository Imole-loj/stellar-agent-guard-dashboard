"use client";

import { useState } from "react";
import {
  NETWORK,
  redactEndpointUrl,
  safeCopyEndpoint,
  probeReadOnlyEndpoint,
  ENDPOINT_ROLES,
  type ReadOnlyProbeResult,
} from "../lib/guard/network.ts";
import {
  detectNetworkMismatch,
  describeMismatch,
  mismatchExplanation,
  type NetworkMismatch,
} from "../lib/guard/networkSwitch.ts";
import { CopyButton } from "./CopyButton.tsx";

export function rpcHostname(rpcUrl: string): string {
  try {
    return new URL(rpcUrl).hostname || rpcUrl;
  } catch (error) {
    if (error instanceof TypeError) return rpcUrl;
    throw error;
  }
}

export interface ConfigureNetworkContextProps {
  networkName?: string;
  rpcUrl?: string;
  walletPassphrase?: string | null;
  walletNetwork?: string | null;
  interactive?: boolean;
  onConfirmWriteNetwork?: (targetNetwork: string) => void | Promise<void>;
  onProbe?: (result: ReadOnlyProbeResult) => void;
  probeImpl?: (url: string) => Promise<ReadOnlyProbeResult>;
}

export function ConfigureNetworkContext({
  networkName = NETWORK.name,
  rpcUrl = NETWORK.rpcUrl,
  walletPassphrase,
  walletNetwork,
  interactive = false,
  onConfirmWriteNetwork,
  onProbe,
  probeImpl,
}: ConfigureNetworkContextProps) {
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<ReadOnlyProbeResult | null>(null);
  const [confirmingWriteSwitch, setConfirmingWriteSwitch] = useState(false);

  const safeRpcUrl = redactEndpointUrl(rpcUrl);

  const mismatch: NetworkMismatch | null =
    walletPassphrase !== undefined
      ? detectNetworkMismatch(walletPassphrase, undefined, {
          targetNetwork: networkName,
          walletNetwork: walletNetwork ?? null,
        })
      : null;

  async function handleProbe() {
    setProbing(true);
    try {
      const probeFn = probeImpl ?? probeReadOnlyEndpoint;
      const res = await probeFn(rpcUrl);
      setProbeResult(res);
      onProbe?.(res);
    } catch (err) {
      const res: ReadOnlyProbeResult = {
        ok: false,
        endpointOrigin: rpcHostname(rpcUrl),
        latencyMs: 0,
        failure: "network",
        detail: err instanceof Error ? err.message : String(err),
      };
      setProbeResult(res);
      onProbe?.(res);
    } finally {
      setProbing(false);
    }
  }

  async function handleConfirmWriteSwitch() {
    if (onConfirmWriteNetwork) {
      await onConfirmWriteNetwork(networkName);
    }
    setConfirmingWriteSwitch(false);
  }

  if (!interactive) {
    return (
      <div className="configure-network-context" aria-label="Configured network">
        <span className="pill" data-testid="configure-network-name">
          {networkName}
        </span>
        <code
          className="configure-network-host"
          data-testid="configure-rpc-hostname"
          title={safeRpcUrl}
        >
          {rpcHostname(rpcUrl)}
        </code>
      </div>
    );
  }

  return (
    <div
      className="configure-network-context-interactive"
      aria-label="Network and RPC configuration"
    >
      <div className="configure-network-context">
        <span className="pill" data-testid="configure-network-name">
          {networkName}
        </span>
        <code
          className="configure-network-host"
          data-testid="configure-rpc-hostname"
          title={safeRpcUrl}
        >
          {rpcHostname(rpcUrl)}
        </code>
        <CopyButton value={safeCopyEndpoint(rpcUrl)} label="RPC endpoint" className="tiny" />
      </div>

      {/* Role explanation (Issue #508) */}
      <section className="network-roles-explanation" data-testid="network-roles-explanation">
        <div className="role-card" data-testid="role-read-only">
          <span className="role-title">Read-Only RPC: </span>
          <span className="role-desc">{ENDPOINT_ROLES.readOnly.description}</span>
        </div>
        <div className="role-card" data-testid="role-write-network">
          <span className="role-title">Write Network: </span>
          <span className="role-desc">{ENDPOINT_ROLES.writeNetwork.description}</span>
        </div>
      </section>

      {/* Operator-controlled read-only endpoint probe (Issue #506) */}
      <section className="endpoint-probe-section" data-testid="endpoint-probe-section">
        <button
          type="button"
          className="btn-secondary probe-btn"
          data-testid="probe-endpoint-button"
          onClick={handleProbe}
          disabled={probing}
        >
          {probing ? "Probing endpoint..." : "Probe Endpoint"}
        </button>

        {probeResult && (
          <div className="probe-result" data-testid="probe-result">
            {probeResult.ok ? (
              <>
                <span className="pill ok" data-testid="probe-latency">
                  {probeResult.latencyMs} ms
                </span>
                <span className="pill info" data-testid="probe-network-identity">
                  {probeResult.networkName} ({probeResult.passphrase})
                </span>
              </>
            ) : (
              <span className="pill warn" data-testid="probe-error">
                {probeResult.detail}
              </span>
            )}
          </div>
        )}
      </section>

      {/* Network mismatch & confirmation before changing write network (Issue #508) */}
      {mismatch && (
        <section className="network-mismatch-banner" data-testid="network-mismatch-banner">
          <p className="mismatch-headline" data-testid="mismatch-headline">
            {describeMismatch(mismatch)}
          </p>
          <p className="mismatch-explanation" data-testid="mismatch-explanation">
            {mismatchExplanation(mismatch)}
          </p>

          {!confirmingWriteSwitch ? (
            <button
              type="button"
              className="btn-warn"
              data-testid="request-write-network-switch"
              onClick={() => setConfirmingWriteSwitch(true)}
            >
              Change Write Network to {networkName}
            </button>
          ) : (
            <div
              className="write-network-confirm-dialog"
              data-testid="write-network-confirm-dialog"
            >
              <p data-testid="write-network-confirm-warning">
                Explicit confirmation required: Are you sure you want to change the write network to{" "}
                {networkName}? Signatures produced on {networkName} cannot authorize calls on other
                networks.
              </p>
              <div className="confirm-actions">
                <button
                  type="button"
                  className="btn-primary"
                  data-testid="confirm-write-network-switch"
                  onClick={handleConfirmWriteSwitch}
                >
                  Confirm Change to {networkName}
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  data-testid="cancel-write-network-switch"
                  onClick={() => setConfirmingWriteSwitch(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

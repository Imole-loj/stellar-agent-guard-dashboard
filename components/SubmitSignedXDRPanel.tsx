"use client";

import { useMemo, useState } from "react";
import { useGuard } from "./GuardProvider.tsx";
import { ErrorBlock, starLink } from "./bits.tsx";
import { Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import { NETWORK } from "../lib/guard/network.ts";
import { preflightSignedEnvelope, type SignedEnvelopePreflight } from "../lib/guard/submit.ts";
import { announce } from "../lib/guard/useAnnounce.ts";
import { usePwaActivity } from "../lib/guard/usePwaActivity.ts";
import { mergeSignedEnvelopes, type MergeSignedEnvelopesResult } from "../lib/guard/multisig.ts";
import { createHorizonServer, readAccountSigners } from "../lib/guard/multisigRead.ts";
import { inspectSignedEnvelope } from "../lib/guard/submit.ts";

type MergeReport = Extract<MergeSignedEnvelopesResult, { ok: true }>;

export function SubmitSignedXDRPanel() {
  const { server } = useGuard();
  const [xdr, setXdr] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successHash, setSuccessHash] = useState<string | null>(null);
  // Partial-envelope merging (#372). The merged XDR is loaded into the same
  // submission box, so the operator reviews the exact bytes that will be sent.
  const [mergeInput, setMergeInput] = useState("");
  const [mergeReport, setMergeReport] = useState<MergeReport | null>(null);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [merging, setMerging] = useState(false);
  const [verificationNote, setVerificationNote] = useState<string | null>(null);

  const [preflight, setPreflight] = useState<SignedEnvelopePreflight | null>(null);
  const [checkedEnvelope, setCheckedEnvelope] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  // A pending write is work an app-shell update must not interrupt (#398).
  usePwaActivity(busy || merging, "write");

  const inspection = useMemo(() => inspectSignedEnvelope(xdr.trim(), NETWORK.passphrase), [xdr]);

  async function checkEnvelope() {
    setChecking(true);
    setError(null);
    setPreflight(null);
    setCheckedEnvelope(null);
    try {
      const envelope = TransactionBuilder.fromXDR(xdr.trim(), NETWORK.passphrase);
      const result = await preflightSignedEnvelope(server, envelope);
      setPreflight(result);
      setCheckedEnvelope(xdr.trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  }

  async function submit() {
    if (!inspection.canSubmit) {
      setError("Cannot submit: envelope validation or network check failed.");
      return;
    }
    if (!preflight || checkedEnvelope !== xdr.trim()) {
      setError("Check this envelope against the latest account and ledger before submitting.");
      return;
    }
    setBusy(true);
    setError(null);
    setSuccessHash(null);
    try {
      const tx = TransactionBuilder.fromXDR(xdr.trim(), NETWORK.passphrase);
      const response = await server.sendTransaction(tx as any);
      if (response.status === "ERROR") {
        throw new Error(JSON.stringify(response.errorResult || response));
      }
      setSuccessHash(response.hash);
      announce("Externally signed transaction submitted to network");
      setXdr("");
      setPreflight(null);
      setCheckedEnvelope(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Combine partial envelopes.
   *
   * Verification needs the source account's signer keys. The dashboard reads
   * them from Horizon when it can; if that read fails (an air-gapped workstation,
   * for example) the merge still runs, but the report says the signatures were
   * not network-verified instead of implying they were.
   */
  async function merge() {
    const envelopes = mergeInput
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "");
    if (envelopes.length < 2) {
      setMergeError("Paste at least two signed envelopes, one base64 XDR per line.");
      return;
    }

    setMerging(true);
    setMergeError(null);
    setMergeReport(null);
    setVerificationNote(null);
    try {
      let signers: string[] = [];
      try {
        const first = TransactionBuilder.fromXDR(envelopes[0]!, NETWORK.passphrase);
        const source = first instanceof Transaction ? first.source : null;
        if (source === null) {
          setVerificationNote(
            "Signatures were not network-verified: the first input is not a transaction envelope.",
          );
        } else {
          const account = await readAccountSigners(createHorizonServer(), source);
          if (account.ok) {
            signers = account.value.signers
              .filter((signer) => signer.kind === "ed25519" || signer.kind === undefined)
              .map((signer) => signer.key);
          } else {
            setVerificationNote(
              `Signatures were not network-verified: the source account's signers could not be read (${account.error}).`,
            );
          }
        }
      } catch {
        setVerificationNote(
          "Signatures were not network-verified because the first envelope could not be decoded.",
        );
      }

      const result = mergeSignedEnvelopes({
        envelopes: envelopes.map((envelope, index) => ({
          xdr: envelope,
          label: `Envelope ${index + 1}`,
        })),
        networkPassphrase: NETWORK.passphrase,
        ...(signers.length > 0 ? { signers } : {}),
      });
      if (!result.ok) {
        setMergeError(result.error);
        return;
      }
      setMergeReport(result);
      setXdr(result.mergedXdr);
      setMergeInput("");
      setSuccessHash(null);
      announce(
        `${result.signatures.length} signature${result.signatures.length === 1 ? "" : "s"} merged — review the envelope before submitting`,
      );
    } finally {
      setMerging(false);
    }
  }

  return (
    <div className="panel">
      <h2>Submit Signed XDR</h2>
      <p className="tiny muted">
        Broadcast an externally assembled and signed transaction envelope. Inspect its network
        binding, source, operation types, and context before broadcast.
      </p>

      <details className="merge-panel">
        <summary>Merge partial signatures (multisig / air-gapped)</summary>
        <p className="tiny muted">
          Combine separately signed copies of the same envelope. Source, sequence, fee, time bounds,
          operations and authorization payloads must match exactly; incompatible inputs are refused
          without combining anything. Duplicate signatures are counted once, and two different
          signatures that share a signer hint are both preserved and reported.
        </p>
        <textarea
          value={mergeInput}
          onChange={(event) => setMergeInput(event.target.value)}
          placeholder={"One signed transaction envelope per line (base64)\nAAAAAg…"}
          style={{ width: "100%", height: "96px", marginBottom: "12px", fontFamily: "monospace" }}
          aria-label="Partial signed envelopes, one base64 XDR per line"
        />
        <div className="row">
          <button
            type="button"
            className="secondary"
            disabled={merging || mergeInput.trim() === ""}
            onClick={merge}
          >
            {merging ? "Merging…" : "Merge signatures"}
          </button>
        </div>

        {mergeError && <ErrorBlock title="Merge refused" detail={mergeError} context="write" />}

        {mergeReport && (
          <div className="notice info merge-report" role="status">
            <strong>
              {mergeReport.signatures.length} unique signature
              {mergeReport.signatures.length === 1 ? "" : "s"} merged for {NETWORK.name}
            </strong>
            <span className="tiny mono breakable">
              {mergeReport.facts.source} · sequence {mergeReport.facts.sequence}
            </span>
            <span className="tiny">
              {mergeReport.duplicates.length} duplicate
              {mergeReport.duplicates.length === 1 ? "" : "s"}, {mergeReport.conflicts.length} hint
              conflict{mergeReport.conflicts.length === 1 ? "" : "s"}. The merged envelope is loaded
              in the submission box below — review it before submitting.
            </span>
            <span className="tiny">
              {mergeReport.signatures.filter((signature) => signature.verification === "verified")
                .length === mergeReport.signatures.length
                ? "Every signature verified against the source account's signers on this network."
                : `${mergeReport.signatures.filter((signature) => signature.verification === "verified").length} of ${mergeReport.signatures.length} signatures were verified against known signers; the rest were left unchecked rather than attributed to the wrong key.`}
            </span>
            {verificationNote && <span className="tiny muted">{verificationNote}</span>}

            {mergeReport.duplicates.length > 0 && (
              <ul className="tiny" style={{ margin: "4px 0 0 16px", padding: 0 }}>
                {mergeReport.duplicates.map((duplicate) => (
                  <li key={`duplicate-${duplicate.hint}-${duplicate.signature}`}>
                    duplicate hint {duplicate.hint}: carried by {duplicate.sources.join(", ")}
                  </li>
                ))}
              </ul>
            )}
            {mergeReport.conflicts.length > 0 && (
              <ul className="tiny" style={{ margin: "4px 0 0 16px", padding: 0 }}>
                {mergeReport.conflicts.map((conflict) => (
                  <li key={`conflict-${conflict.hint}`}>
                    hint {conflict.hint} has {conflict.signatures.length} distinct signatures (
                    {conflict.sources.join(", ")}); both were kept.
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </details>

      <textarea
        value={xdr}
        onChange={(e) => {
          setXdr(e.target.value);
          setPreflight(null);
          setCheckedEnvelope(null);
          setError(null);
        }}
        placeholder="Paste signed transaction XDR here (base64)"
        style={{ width: "100%", height: "80px", marginBottom: "12px", fontFamily: "monospace" }}
        aria-label="Signed transaction XDR"
      />

      {xdr.trim().length > 0 && (
        <div
          className="review-box"
          style={{
            marginBottom: "16px",
            padding: "12px",
            border: "1px solid var(--border-subtle, #333)",
            borderRadius: "6px",
          }}
          data-testid="signed-xdr-review"
        >
          <div className="row" style={{ gap: "8px", flexWrap: "wrap", marginBottom: "8px" }}>
            {inspection.networkMatch ? (
              <span className="pill ok" data-testid="network-match-badge">
                Network: Verified match ({NETWORK.name})
              </span>
            ) : (
              <span className="pill danger" data-testid="network-mismatch-badge">
                Network mismatch:{" "}
                {inspection.detectedNetwork
                  ? `Signed for ${inspection.detectedNetwork}`
                  : "Does not match current network"}
              </span>
            )}

            {inspection.timeBounds?.expired ? (
              <span className="pill danger" data-testid="expired-badge">
                Expired (maxTime: {inspection.timeBounds.maxTime})
              </span>
            ) : inspection.timeBounds?.maxTime ? (
              <span className="pill ok" data-testid="valid-time-badge">
                Valid timebounds
              </span>
            ) : null}

            <span className="pill info" data-testid="signatures-badge">
              {inspection.signaturesCount} signature{inspection.signaturesCount === 1 ? "" : "s"}
            </span>
          </div>

          {inspection.verifiedFields.length > 0 && (
            <div style={{ marginTop: "8px" }}>
              <div className="tiny muted">
                <strong>Verified fields:</strong>
              </div>
              <ul style={{ margin: "4px 0", paddingLeft: "20px" }}>
                {inspection.verifiedFields.map((field, idx) => (
                  <li key={idx} className="tiny mono">
                    {field}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {inspection.unsupportedFields.length > 0 && (
            <div className="notice danger" style={{ marginTop: "8px", padding: "8px" }}>
              <div className="tiny">
                <strong>Unsupported fields (submission blocked):</strong>
              </div>
              <ul style={{ margin: "4px 0", paddingLeft: "20px" }}>
                {inspection.unsupportedFields.map((field, idx) => (
                  <li key={idx} className="tiny mono">
                    {field}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {inspection.blockReasons.length > 0 && (
            <div style={{ marginTop: "8px" }}>
              <ErrorBlock
                title="Submission blocked before broadcast"
                detail={inspection.blockReasons.join(" · ")}
              />
            </div>
          )}
        </div>
      )}

      <div className="row">
        <button
          className="secondary"
          disabled={busy || checking || !xdr.trim()}
          onClick={() => void checkEnvelope()}
        >
          {checking ? "Checking latest ledger…" : "Check envelope"}
        </button>
        <button
          disabled={
            busy ||
            checking ||
            !xdr.trim() ||
            checkedEnvelope !== xdr.trim() ||
            !inspection.canSubmit
          }
          onClick={() => void submit()}
        >
          {busy ? "Submitting..." : "Submit to Network"}
        </button>
      </div>
      {preflight && checkedEnvelope === xdr.trim() && (
        <div className="notice info" role="status" style={{ marginTop: 12 }}>
          <strong>
            Read-only preflight, checked {new Date(preflight.checkedAt).toLocaleString()}
          </strong>
          <span className="tiny">
            Sequence: {preflight.sequence.status.replaceAll("_", " ")} — {preflight.sequence.detail}
          </span>
          <span className="tiny">
            Expiration: {preflight.expiration.status.replaceAll("_", " ")} —{" "}
            {preflight.expiration.detail}
          </span>
          <span className="tiny muted">
            Advisory only. No envelope fields were changed; the network&apos;s final RPC response is
            authoritative.
          </span>
        </div>
      )}
      {error && (
        <ErrorBlock title="Submission failed" detail={error} context="write" stage="submission" />
      )}
      {successHash && (
        <div className="notice info" style={{ marginTop: "16px" }}>
          <strong>Transaction submitted — {starLink(successHash)}</strong>
        </div>
      )}
    </div>
  );
}

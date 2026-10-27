/**
 * Failure-to-guidance mapping (issue #385).
 *
 * During an incident an operator should not have to search the repository for
 * the runbook that matches an error string. This module recognises the failure
 * categories the dashboard can actually prove from an error, attaches the
 * relevant runbook link, and states whether a retry is safe.
 *
 * Two rules keep it honest:
 *
 *  1. The original error summary is always preserved verbatim. Guidance is an
 *     addition, never a replacement for what the network or wallet said.
 *  2. Only recognised categories get a link. An unknown error returns no
 *     runbook and no retry advice, because a plausible-looking instruction for
 *     a failure we do not understand is worse than none.
 *
 * Read failures and write failures are deliberately distinct. A failed RPC read
 * is safe to repeat; a write whose broadcast outcome is unknown is not, because
 * the transaction may already be included. The wording says which one it is
 * instead of a generic "try again".
 */

export type FailureCategory =
  | "wallet_rejected"
  | "wallet_unavailable"
  | "network_mismatch"
  | "account_unfunded"
  | "simulation_refused"
  | "guard_refused"
  | "auth_mismatch"
  | "transaction_expired"
  | "sequence_mismatch"
  | "insufficient_fee"
  | "network_unavailable"
  | "submission_rejected"
  | "on_chain_failed"
  | "unknown";

/** What kind of retry, if any, the evidence supports. */
export type RetrySafety = "read-safe" | "write-safe" | "write-ambiguous" | "none" | "undetermined";

export interface RecoveryLink {
  label: string;
  href: string;
}

export interface RecoveryGuidance {
  category: FailureCategory;
  /** The original error summary, unchanged. */
  summary: string;
  /** What the dashboard can conclude from this failure, in one sentence. */
  explanation: string;
  retry: RetrySafety;
  /** A sentence an operator can act on without opening the link. */
  retryLabel: string;
  link: RecoveryLink | null;
  /** `false` only for the unknown fallback. */
  recognized: boolean;
}

export interface ClassifyFailureInput {
  message: string;
  /**
   * The write stage that produced the failure, when the caller knows it.
   * `discovery` and `enforcement` are pre-broadcast; `submission` is the
   * sendTransaction boundary.
   */
  stage?: "discovery" | "enforcement" | "submission" | string;
  /** `read` for an RPC/state read, `write` (default) for a signed write path. */
  context?: "read" | "write";
}

export interface RecoveryRule {
  category: Exclude<FailureCategory, "unknown">;
  pattern: RegExp;
}

/**
 * Ordered matchers. The first match wins, so the more specific evidence comes
 * first: an included-and-rejected transaction is never advice about a wallet
 * prompt, and a sequence rejection is never reported as a generic submission
 * failure.
 */
export const RECOVERY_RULES: readonly RecoveryRule[] = [
  {
    category: "wallet_rejected",
    pattern:
      /(user|client|operator).{0,20}(reject|declin|denied|cancel)|(reject|declin|denied|cancel).{0,20}(by the user|by user|signature|request)/i,
  },
  {
    category: "wallet_unavailable",
    pattern:
      /freighter|wallet.{0,20}(not connected|unavailable|not found|not installed)|extension.{0,20}(not installed|missing|unavailable)/i,
  },
  {
    category: "network_mismatch",
    pattern:
      /network (mismatch|does not match|doesn't match)|wrong network|right network|network passphrase|passphrase.{0,20}(mismatch|does not match)/i,
  },
  {
    category: "account_unfunded",
    pattern:
      /not funded|unfunded|account not found|op_no_account|does not exist on|is the account funded/i,
  },
  {
    category: "transaction_expired",
    pattern: /expired|tx_too_late|tx_too_early|time bounds|timebounds/i,
  },
  {
    category: "sequence_mismatch",
    pattern: /tx_bad_seq|bad sequence|sequence (number|mismatch)/i,
  },
  {
    category: "insufficient_fee",
    pattern:
      /insufficient.{0,20}fee|fee (is )?too low|tx_insufficient_fee|resource fee|fee budget|max fee/i,
  },
  {
    category: "network_unavailable",
    pattern:
      /timeout|timed out|try_again_later|not_found|429|rate limit|too many requests|failed to fetch|network error|econn|service unavailable|50[234]/i,
  },
  {
    category: "on_chain_failed",
    pattern:
      /included and rejected|failed on chain|rejected by the network|tx_failed|op_inner|trapped/i,
  },
  {
    category: "guard_refused",
    pattern:
      /admin_frozen|dead.?man|window (cap|spend)|allowlist|spend cap|guard (refused|blocked)|policy (refused|rejected|blocked)/i,
  },
  {
    category: "auth_mismatch",
    pattern:
      /must be authorized by|connected wallet is|admin role|unauthorized function|invalid_action|tx_bad_auth|unauthorized/i,
  },
  {
    category: "simulation_refused",
    pattern: /simulation|simulate|host error|host:|invoke_host_function|diagnostic/i,
  },
  {
    category: "submission_rejected",
    pattern:
      /rejected at submission|refused the transaction|sendtransaction|transaction refused|submission/i,
  },
];

const DOCS_BASE = "https://github.com/Stellar-Agent-Guard/stellar-agent-guard-dashboard/blob/main";

interface GuidanceCopy {
  explanation: string;
  retry: RetrySafety;
  retryLabel: string;
  link: RecoveryLink | null;
}

const RETRY_COPY: Record<RetrySafety, string> = {
  "read-safe": "Safe to retry: this was a read and it did not change on-chain state.",
  "write-safe": "Safe to retry after fixing the cause: nothing was broadcast, so nothing changed.",
  "write-ambiguous":
    "Do not retry yet: the write may have reached the network. Verify the transaction hash or the account's on-chain state first.",
  none: "Do not retry blindly: this failure will not be fixed by resending the same request.",
  undetermined:
    "No retry guidance is available. Check the account and transaction on-chain before trying again.",
};

const GUIDANCE: Record<Exclude<FailureCategory, "unknown">, GuidanceCopy> = {
  wallet_rejected: {
    explanation:
      "The wallet declined the signature request, so nothing was signed and nothing was broadcast.",
    retry: "none",
    retryLabel:
      "Nothing changed on chain. Review the request and approve the next wallet prompt if it is correct.",
    link: {
      label: "Air-gapped signing — verify the request before signing",
      href: `${DOCS_BASE}/docs/guides/air-gapped-multisig-signing.md`,
    },
  },
  wallet_unavailable: {
    explanation:
      "The dashboard could not reach a usable wallet connection, so no signature was requested.",
    retry: "none",
    retryLabel:
      "Connect or unlock the wallet, confirm it is on the network shown in the header, then retry.",
    link: {
      label: "Air-gapped signing — before you start",
      href: `${DOCS_BASE}/docs/guides/air-gapped-multisig-signing.md`,
    },
  },
  network_mismatch: {
    explanation:
      "The wallet and the dashboard disagree about the network, so a signature cannot authorize this call.",
    retry: "none",
    retryLabel:
      "Switch the wallet to the dashboard's network first; retrying on the wrong network cannot succeed.",
    link: {
      label: "Air-gapped signing — verify the network",
      href: `${DOCS_BASE}/docs/guides/air-gapped-multisig-signing.md`,
    },
  },
  account_unfunded: {
    explanation:
      "The source account could not be loaded from the network — usually because it is unfunded or on another network.",
    retry: "write-safe",
    retryLabel:
      "Fund the account (or switch to the correct network) and retry; nothing was broadcast.",
    link: {
      label: "Agent integration — account and network setup",
      href: `${DOCS_BASE}/docs/guides/agent-integration.md`,
    },
  },
  simulation_refused: {
    explanation:
      "Pre-flight simulation failed before the write was signed, so no transaction left the browser.",
    retry: "write-safe",
    retryLabel:
      "Nothing was broadcast. Fix the simulation error, then rebuild and resubmit the transaction.",
    link: {
      label: "Policy updates — local validation and pre-flight",
      href: `${DOCS_BASE}/docs/runbooks/policy-updates.md`,
    },
  },
  guard_refused: {
    explanation:
      "The guard's policy refused the call during enforced simulation. Resending the same call will be refused again.",
    retry: "none",
    retryLabel:
      "Nothing was broadcast. Change the policy or the request so it satisfies the installed rules before retrying.",
    link: {
      label: "Policy updates — before you start",
      href: `${DOCS_BASE}/docs/runbooks/policy-updates.md`,
    },
  },
  auth_mismatch: {
    explanation:
      "The call must be authorized by a different key than the connected wallet, or the authorization payload was rejected.",
    retry: "none",
    retryLabel:
      "Connect the account that holds the admin role for this guard; repeating the same signature cannot succeed.",
    link: {
      label: "Emergency freeze — key rotation and incident response",
      href: `${DOCS_BASE}/docs/runbooks/emergency-freeze.md`,
    },
  },
  transaction_expired: {
    explanation:
      "The transaction's time bounds expired before it was submitted, so the network will not accept it.",
    retry: "write-safe",
    retryLabel:
      "Nothing was broadcast. Rebuild the envelope with fresh time bounds, then sign and submit again.",
    link: {
      label: "Air-gapped signing — expired envelopes",
      href: `${DOCS_BASE}/docs/guides/air-gapped-multisig-signing.md`,
    },
  },
  sequence_mismatch: {
    explanation:
      "The transaction's sequence number no longer matches the source account, so the network rejected it.",
    retry: "write-safe",
    retryLabel:
      "Nothing was included. Reload the account sequence, rebuild the transaction, and submit again.",
    link: {
      label: "Air-gapped signing — stale sequences",
      href: `${DOCS_BASE}/docs/guides/air-gapped-multisig-signing.md`,
    },
  },
  insufficient_fee: {
    explanation:
      "The resource or inclusion fee was below what the network requires, so the transaction was not included.",
    retry: "write-safe",
    retryLabel:
      "Nothing was included. Raise the fee preset or cap, rebuild the transaction, and submit again.",
    link: {
      label: "Policy updates — submit and verify",
      href: `${DOCS_BASE}/docs/runbooks/policy-updates.md`,
    },
  },
  network_unavailable: {
    explanation: "The RPC or network did not answer, or asked the client to try again later.",
    retry: "read-safe",
    retryLabel: RETRY_COPY["read-safe"],
    link: {
      label: "Agent integration — diagnosing RPC and telemetry",
      href: `${DOCS_BASE}/docs/guides/agent-integration.md`,
    },
  },
  submission_rejected: {
    explanation:
      "The network refused the transaction at submission, before it was included in a ledger.",
    retry: "write-safe",
    retryLabel:
      "Nothing was included. Resolve the submission error and rebuild the transaction before retrying.",
    link: {
      label: "Air-gapped signing — rejected transactions",
      href: `${DOCS_BASE}/docs/guides/air-gapped-multisig-signing.md`,
    },
  },
  on_chain_failed: {
    explanation:
      "The transaction was included in a ledger but the operation failed. It may have consumed fees and changed state.",
    retry: "none",
    retryLabel:
      "Do not resend it. Preserve the result and diagnostic events, then follow the runbook for the failure.",
    link: {
      label: "Policy updates — rollback and recovery",
      href: `${DOCS_BASE}/docs/runbooks/policy-updates.md`,
    },
  },
};

const UNKNOWN_GUIDANCE: GuidanceCopy = {
  explanation:
    "The dashboard does not recognise this failure, so it will not guess at a recovery step.",
  retry: "undetermined",
  retryLabel: RETRY_COPY.undetermined,
  link: null,
};

/**
 * Classify a failure and return its guidance.
 *
 * `stage` and `context` refine the answer where the message alone is not enough:
 * an unrecognised discovery/enforcement failure is still a pre-broadcast
 * simulation failure, and a network error on a read is a safe retry while the
 * same error during a write is ambiguous.
 */
export function classifyFailure(input: ClassifyFailureInput): RecoveryGuidance {
  const message = input.message;
  const context = input.context ?? "write";
  const matched = RECOVERY_RULES.find((rule) => rule.pattern.test(message));
  let category: FailureCategory = matched?.category ?? "unknown";

  if (category === "unknown" && input.stage === "discovery") category = "simulation_refused";
  if (category === "unknown" && input.stage === "enforcement") category = "guard_refused";
  if (category === "unknown" && input.stage === "submission") category = "submission_rejected";

  if (category === "unknown") {
    return {
      category,
      summary: message,
      explanation: UNKNOWN_GUIDANCE.explanation,
      retry: UNKNOWN_GUIDANCE.retry,
      retryLabel: UNKNOWN_GUIDANCE.retryLabel,
      link: null,
      recognized: false,
    };
  }

  const copy = GUIDANCE[category];
  // A network failure is the one category whose retry safety depends on what was
  // being attempted: reads are repeatable, writes may already be in flight.
  const retry: RetrySafety =
    category === "network_unavailable"
      ? context === "read"
        ? "read-safe"
        : "write-ambiguous"
      : copy.retry;

  return {
    category,
    summary: message,
    explanation: copy.explanation,
    retry,
    retryLabel: retry === copy.retry ? copy.retryLabel : RETRY_COPY[retry],
    link: copy.link,
    recognized: true,
  };
}

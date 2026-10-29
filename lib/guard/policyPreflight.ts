/**
 * On-chain policy preflight: `validate_policy(config) -> ValidationOutcome`
 * (SPEC §8.1 of stellar-agent-guard-contracts, added there by issue #35).
 *
 * Until now the only signal available to this console was the single stable
 * `InvalidConfig` code `set_policy` returns: every one of the §8 rules collapsed
 * into one opaque rejection, and an operator learned which rule they broke only
 * by paying for a signed transaction that went nowhere. `validate_policy` is a
 * read — no auth, no events, no state writes — that dry-runs the *candidate*
 * config against the same rules in the same order and answers `Valid`, or
 * `Invalid(PolicyRuleId)` naming the first rule that fails.
 *
 * The read is deliberately **additive**: a contract that predates the entry
 * point, an RPC hiccup or an undecodable payload all read as "no verdict", which
 * never blocks a write. `set_policy` still rejects with `invalid_config` on
 * chain, so the fail-closed guarantee lives with the contract, not with this
 * preflight. See `preflightDecision`.
 */

import { xdr } from "@stellar/stellar-sdk";

/**
 * The contract's `PolicyRuleId` variants, in SPEC §8.1 evaluation order.
 *
 * The contract enum grows append-only ("variants added after the original set
 * preserve their established contract-type ordinals"), so this list is the
 * vocabulary as of SPEC §8.1's table — `describePolicyRule` stays total over
 * strings, and a rule this dashboard does not know yet still renders as a block
 * rather than crashing the form.
 */
export const POLICY_RULE_IDS = [
  "AssetListTooLong",
  "ProtocolListTooLong",
  "RecipientListTooLong",
  "AmountSign",
  "WindowRequiresWidth",
  "ActiveWindowOrder",
  "SelfAddressInList",
  "DuplicateAddressInList",
  "DuplicateRecipientCap",
  "RecipientCapSign",
  "RecipientAllowAndBlocked",
  "ProtocolContractDuplicate",
  "ProtocolFnListInvalid",
  "PerTxCapExceedsWindowCap",
  "DurationExceedsBound",
  "AssetCapListTooLong",
  "AssetCapUnknownAsset",
  "DuplicateAssetCap",
] as const;

export type PolicyRuleId = (typeof POLICY_RULE_IDS)[number];

/** Where in the policy editor a rule applies, and why the guard would reject it. */
export interface PolicyRuleGuidance {
  /** The form field (in the operator's terms) the rule is about. */
  field: string;
  /** A sentence that names the offending input, not just the rule. */
  message: string;
}

/**
 * Field-targeted copy for every rule `validate_policy` can report.
 *
 * Wording follows the local draft validation where the same rule already has a
 * sentence (e.g. the window-width rule), so the operator reads one vocabulary
 * whether the form caught the mistake or the contract did.
 */
export const POLICY_RULE_GUIDANCE: Record<PolicyRuleId, PolicyRuleGuidance> = {
  AssetListTooLong: {
    field: "Assets",
    message: "the asset list is limited to 256 entries",
  },
  ProtocolListTooLong: {
    field: "Protocols",
    message: "the protocol list is limited to 256 entries",
  },
  RecipientListTooLong: {
    field: "Recipients",
    message: "the recipient lists are limited to 256 entries",
  },
  AmountSign: {
    field: "Spend caps",
    message: "a spend cap cannot be negative",
  },
  WindowRequiresWidth: {
    field: "Rolling-window length",
    message: "a spend cap requires a non-zero window width",
  },
  ActiveWindowOrder: {
    field: "Active until",
    message: "the active window must end after it starts",
  },
  SelfAddressInList: {
    field: "Allowlists",
    message: "the guard's own address cannot appear in an allowlist",
  },
  DuplicateAddressInList: {
    field: "Allowlists",
    message: "an allowlist cannot contain the same entry twice",
  },
  DuplicateRecipientCap: {
    field: "Recipients",
    message: "a recipient can have only one window cap",
  },
  RecipientCapSign: {
    field: "Recipients",
    message: "a per-recipient cap cannot be negative",
  },
  RecipientAllowAndBlocked: {
    field: "Recipients",
    message: "a recipient cannot be allowed and blocked at the same time",
  },
  ProtocolContractDuplicate: {
    field: "Protocols",
    message: "the protocol list cannot repeat a contract",
  },
  ProtocolFnListInvalid: {
    field: "Protocols",
    message: "a protocol's function list must be non-empty and free of duplicates",
  },
  PerTxCapExceedsWindowCap: {
    field: "Per-transaction cap",
    message: "the per-transaction cap cannot exceed the rolling-window cap",
  },
  DurationExceedsBound: {
    field: "Window length",
    message:
      "the rolling-window length and dead-man grace are each limited to 315360000 seconds (about 10 years)",
  },
  AssetCapListTooLong: {
    field: "Asset caps",
    message: "asset caps are limited to 256 entries",
  },
  AssetCapUnknownAsset: {
    field: "Asset caps",
    message: "an asset cap can only override an asset that is in the asset list",
  },
  DuplicateAssetCap: {
    field: "Asset caps",
    message: "an asset can appear only once in the asset caps",
  },
};

/**
 * Guidance for any rule id, including one from a contract build newer than this
 * dashboard. The id is surfaced verbatim so an unknown rule is still actionable
 * (and still blocks) instead of being mistaken for a valid policy.
 */
export function describePolicyRule(rule: string): PolicyRuleGuidance {
  const known = POLICY_RULE_IDS.find((id) => id === rule);
  if (known !== undefined) return POLICY_RULE_GUIDANCE[known];
  return {
    field: "The policy",
    message: `the guard rejected this policy under rule "${rule}" (SPEC §8)`,
  };
}

/** What `validate_policy` answered for the candidate config. */
export type ValidationOutcome = { kind: "valid" } | { kind: "invalid"; rule: string };

/** Variant names ride in `ScVal::Symbol` (or a stringly-typed RPC surface). */
function variantName(sc: xdr.ScVal): string | null {
  if (sc.type === "scvSymbol" || sc.type === "scvString") return sc.value;
  return null;
}

/**
 * A unit-variant payload — `PolicyRuleId` is itself a unit-only enum, so it
 * arrives as `Vec([Symbol(rule)])`, while a stringly-typed surface may hand
 * back the bare name. Both decode to the rule id.
 */
function unwrapSingle(sc: xdr.ScVal): string | null {
  const direct = variantName(sc);
  if (direct !== null) return direct;
  if (sc.type === "scvVec") {
    const items = sc.vec ?? [];
    if (items.length === 1) return variantName(items[0]!);
  }
  return null;
}

/**
 * Decode the `ValidationOutcome` enum: `ScVal::Vec` whose first element names
 * the variant (SEP-0048 enum convention) — `["Valid"]` or
 * `["Invalid", ["WindowRequiresWidth"]]`.
 *
 * Anything else throws, which `readContract` turns into a failed read rather
 * than a value: an undecodable payload must never read as `Valid`.
 */
export function decodeValidationOutcome(retval: xdr.ScVal): ValidationOutcome {
  if (retval.type === "scvVec") {
    const items = retval.vec ?? [];
    const head = items.length > 0 ? variantName(items[0]!) : null;
    if (head === "Valid" && items.length === 1) return { kind: "valid" };
    if (head === "Invalid" && items.length === 2) {
      const rule = unwrapSingle(items[1]!);
      if (rule !== null) return { kind: "invalid", rule };
      throw new Error("validate_policy returned Invalid without a rule id");
    }
    throw new Error("unexpected validate_policy payload shape");
  }
  const bare = variantName(retval);
  if (bare === "Valid") return { kind: "valid" };
  throw new Error(`unexpected validate_policy payload: ${retval.type}`);
}

/**
 * Structural shape of `ReadResult<ValidationOutcome>` — stated here rather than
 * imported from `chain.ts` so this module stays dependency-free (the browser
 * bundle imports it for its copy alone) and cycle-free.
 */
export type PreflightRead = { ok: true; value: ValidationOutcome } | { ok: false; error: string };

export type PreflightDecision =
  { kind: "allow" } | { kind: "block"; rule: string; field: string; message: string };

/**
 * Turn the preflight read into the only two outcomes the form can act on.
 *
 * - `Invalid(rule)` blocks, carrying the rule's field-targeted copy.
 * - `Valid` allows.
 * - A failed read (older contract without `validate_policy`, RPC down,
 *   undecodable payload) allows: the read is additive, and `set_policy`'s own
 *   on-chain `invalid_config` rejection is unchanged for exactly these clients.
 */
export function preflightDecision(read: PreflightRead): PreflightDecision {
  if (!read.ok) return { kind: "allow" };
  if (read.value.kind === "valid") return { kind: "allow" };
  const guidance = describePolicyRule(read.value.rule);
  return { kind: "block", rule: read.value.rule, ...guidance };
}

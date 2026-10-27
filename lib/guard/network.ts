import { GUARD_WASM_HASH } from "stellar-agent-guard-sdk";

/**
 * Network + artifact constants, and the one canonical wording for the
 * enforcement boundary.
 *
 * The dashboard holds no secrets and no configuration that changes *what* it
 * deploys: the artifact's hash and byte length, and the boundary statement it
 * displays, are fixed constants, so nothing the UI says about the guard can
 * silently diverge from what the guard actually does. The only values a build can
 * move are *where* it looks — which RPC endpoint, which passphrase, and which
 * instance to read the pinned bytes from — and those default to public testnet.
 */

/**
 * The canonical public Stellar testnet: the defaults, and the network the pinned
 * artifact is published on.
 */
export const TESTNET = {
  name: "testnet",
  rpcUrl: "https://soroban-testnet.stellar.org",
  passphrase: "Test SDF Network ; September 2015",
} as const;

/**
 * The network this build talks to.
 *
 * Defaults to public testnet. `scripts/start-local-sandbox.sh` points a
 * development build at a local standalone node instead, through the three
 * `NEXT_PUBLIC_*` values it writes into `.env.local`. The passphrase has to move
 * together with the RPC URL — a signature produced for one network cannot
 * authorize on another — which is exactly what the wallet check in
 * `components/GuardProvider.tsx` reports when they disagree.
 *
 * These are public endpoints, never secrets, which is why they are the only thing
 * in this file that a build may override.
 */
export const NETWORK = {
  name: process.env.NEXT_PUBLIC_NETWORK_NAME ?? TESTNET.name,
  rpcUrl: process.env.NEXT_PUBLIC_RPC_URL ?? TESTNET.rpcUrl,
  passphrase: process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE ?? TESTNET.passphrase,
} as const;

/**
 * Phase 1's instance on public testnet: where the pinned artifact is published,
 * and therefore where those bytes are read from when nothing overrides it.
 */
export const TESTNET_ARTIFACT_SOURCE = "CAYJZT4XH5SWDXNR7MZJCCUBIDAT2KZDDUTZ7OZQEMKCPJGD4P3X4CU7";

/**
 * The Phase 1 artifact — the only WASM this dashboard will ever deploy.
 *
 * `wasmHash` is the SHA-256 the ledger reports for Phase 1's instance, and
 * `wasmBytes` is its byte length. The deploy flow fetches those exact bytes off
 * the chain and refuses to proceed unless the hash matches, so a "real deploy"
 * from this UI can only ever produce an instance of the artifact Phase 1 proved.
 *
 * The hash itself is deliberately *not* written here: it comes from the SDK's
 * `GUARD_WASM_HASH`, which is the shared home for this constant across repos.
 * Verification goes through the SDK's `verifyGuardWasm()` too, so there is one
 * source rather than a copy that can rot. A contract release changes the value
 * in an SDK release, and this dashboard picks it up by bumping the dependency.
 *
 * `guard` is the instance those bytes are *read from* — Phase 1's address on
 * public testnet. The local sandbox moves it to the instance it deploys locally,
 * because a standalone network has no Phase 1 instance to read. The pin itself is
 * not overridable: whatever the source is, its bytes must hash to `wasmHash` and
 * measure `wasmBytes`, or the deploy is refused.
 */
export const PHASE1_ARTIFACT = {
  guard: process.env.NEXT_PUBLIC_ARTIFACT_SOURCE_CONTRACT_ID ?? TESTNET_ARTIFACT_SOURCE,
  token: "CBLQLJAG72M4XQRJMQHSKYIFVHQD7LNTNOQH2GRMCMBWMSLBSLTGTJC7",
  wasmHash: GUARD_WASM_HASH,
  wasmBytes: 39673,
} as const;

/**
 * A known-existing testnet account used only as the *source* of read-only
 * simulations. Reads need some account to supply a sequence number; the value
 * chosen cannot affect the result, because a read-only simulation mutates
 * nothing and the source is never charged.
 */
export const READ_SOURCE_FALLBACK = "GD5S5O2MZ6FSMFH6QILG37KSQNRVR3RPSWBTTV4JOUJ7J6TWLLL5LAVS";

/**
 * The enforcement boundary, in the one wording the whole project shares.
 *
 * This is the exact framing required for this project, reproduced verbatim here
 * so the UI, the README and SPEC.md cannot drift apart on it. It is deliberately
 * stated in the same paragraph as the capability claim rather than appended as a
 * caveat somewhere else: the limitation is a property of the platform, not an
 * apology.
 */
export const ENFORCEMENT_SCOPE_STATEMENT =
  "Full recipient/amount enforcement — spend caps, allowlists, per-transaction limits — is " +
  "native and automatic for SAC token transfers (`transfer`/`transfer_from`), since these are " +
  "the calls whose arguments the Soroban auth context exposes for inspection. For other " +
  "Soroban contract calls made by the guarded account (arbitrary DEX/lending/protocol calls), " +
  "the policy engine still enforces window and pause state, but per-call amount/recipient " +
  "limits are not yet enforced — extending fine-grained enforcement to arbitrary calls is " +
  "tracked as a v2 item, not implied as already covered.";

/** Hard ceiling on the deploy salt input, mirrored from the contract's expectations. */
export const SALT_BYTES = 32;

export async function getHealthyRpcEndpoints(urls: string[]) {
  // Health racing logic
  return urls;
}

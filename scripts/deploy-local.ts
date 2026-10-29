/**
 * Deploy the pinned guard artifact to a local standalone Soroban network.
 *
 * `scripts/start-local-sandbox.sh` boots the network and calls this; it is the
 * half of the sandbox that the shell cannot do, and it is kept separate so it can
 * also be run on its own against any RPC endpoint.
 *
 * What it does, in order, and why in this order:
 *   1. fetch the pinned artifact's bytes from *public testnet* (Phase 1's
 *      instance) and check they hash to the pin — so what lands on the local
 *      network is the same bytecode this dashboard is willing to deploy anywhere,
 *      not "whatever was around locally";
 *   2. fund a local admin keypair and a local agent keypair from the standalone
 *      network's own friendbot;
 *   3. upload the bytecode if the local network does not already have that code
 *      entry, then create the guard at the address predicted from the deployer and
 *      salt before anything is signed;
 *   4. re-read the created instance and confirm it runs the pinned bytes;
 *   5. `initialize(admin, agent)` the account, unless it already is;
 *   6. write `.env.local` so `npm run dev` talks to this network and opens on this
 *      guard.
 *
 * Usage:
 *   node scripts/deploy-local.ts [options]
 *   node scripts/deploy-local.ts --help
 *
 * Every write goes through the same `submitOperation` / `initializeGuard` helpers
 * the console calls, with the wallet substituted for a local keypair — the same
 * substitution `scripts/prove-phase3.ts` makes, for the same reason.
 */

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import {
  Address,
  Keypair,
  Operation,
  StrKey,
  TransactionBuilder,
  authorizeEntry,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import {
  createServer,
  fetchContractWasm,
  isInitialized,
  predictContractId,
  verifyWasmIdentity,
} from "../lib/guard/chain.ts";
import { artifactCodePresent, initializeGuard, submitOperation } from "../lib/guard/guardOps.ts";
import { PHASE1_ARTIFACT, TESTNET, TESTNET_ARTIFACT_SOURCE } from "../lib/guard/network.ts";
import { hexToBytes } from "../lib/guard/scval.ts";
import { verifyGuardWasm } from "stellar-agent-guard-sdk";
import type { InvokeResult, WalletSigner } from "../lib/guard/submit.ts";

/** The local standalone network's defaults, as `stellar/quickstart` serves them. */
const LOCAL_RPC_URL = "http://localhost:8000/soroban/rpc";
const LOCAL_PASSPHRASE = "Standalone Network ; February 2017";

/**
 * A fixed salt, so re-running the sandbox reuses (or finds) the same guard address
 * instead of scattering a new account on every run.
 */
const SALT_SEED = "stellar-agent-guard:dashboard:local-sandbox:guard:1";

const ENV_HEADER = [
  "# Local standalone Soroban sandbox — written by scripts/start-local-sandbox.sh",
  "# (which calls scripts/deploy-local.ts). Gitignored; delete it to go back to",
  "# public testnet. NEXT_PUBLIC_* values are inlined by Next at build time, so a",
  "# running dev server has to be restarted after this file changes.",
];

interface Options {
  rpcUrl: string;
  passphrase: string;
  friendbotUrl: string | null;
  artifactRpcUrl: string;
  artifactSource: string;
  envOut: string | null;
  secret: string | null;
  help: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    rpcUrl: LOCAL_RPC_URL,
    passphrase: LOCAL_PASSPHRASE,
    friendbotUrl: null,
    artifactRpcUrl: TESTNET.rpcUrl,
    artifactSource: TESTNET_ARTIFACT_SOURCE,
    envOut: ".env.local",
    secret: null,
    help: false,
  };

  // Local names, so `--env-out` and `--envOut` both work.
  const valued = new Map([
    ["--rpc", "rpcUrl"],
    ["--passphrase", "passphrase"],
    ["--friendbot", "friendbotUrl"],
    ["--artifact-rpc", "artifactRpcUrl"],
    ["--artifact-source", "artifactSource"],
    ["--env-out", "envOut"],
    ["--secret", "secret"],
  ]);

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--no-env") {
      options.envOut = null;
      continue;
    }
    const key = argument === undefined ? undefined : valued.get(argument);
    if (!key) continue;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) continue;
    index += 1;
    if (key === "envOut") {
      options.envOut = value;
      continue;
    }
    if (key === "friendbotUrl") {
      options.friendbotUrl = value;
      continue;
    }
    if (key === "secret") {
      options.secret = value;
      continue;
    }
    options[key as "rpcUrl" | "passphrase" | "artifactRpcUrl" | "artifactSource"] = value;
  }

  return options;
}

const HELP = `Deploy the pinned guard artifact to a local standalone Soroban network.

Usage:
  node scripts/deploy-local.ts [options]

Options:
  --rpc <url>              local RPC endpoint (default: ${LOCAL_RPC_URL})
  --passphrase <text>      local network passphrase (default: ${LOCAL_PASSPHRASE})
  --friendbot <url>        faucet used to fund the local keypairs
                           (default: /friendbot on the RPC's own origin)
  --artifact-rpc <url>     where the pinned bytes are fetched from
                           (default: public testnet, ${TESTNET.rpcUrl})
  --artifact-source <C…>   instance those bytes are read from
                           (default: Phase 1's instance on public testnet)
  --secret <S…>            reuse an admin secret instead of generating one
  --env-out <path>         env file to write (default: .env.local)
  --no-env                 do not write an env file
  --help                   show this message
`;

// ── logging ─────────────────────────────────────────────────────────────────

function step(message: string): void {
  console.log(message);
}

/** One line describing what a write did, including its refusal. */
function outcome(result: InvokeResult): string {
  if (result.kind === "submitted") {
    return `submitted tx ${result.hash} (ledger ${result.ledger})`;
  }
  if (result.kind === "refused") {
    return `refused at ${result.stage}: ${result.detail}`;
  }
  return `included and rejected: ${result.detail}`;
}

// ── keys ────────────────────────────────────────────────────────────────────

/**
 * The wallet seam, backed by a local keypair.
 *
 * Same three methods `components/GuardProvider.tsx` supplies through Freighter, so
 * the code under test here is the console's own operation code and not a parallel
 * implementation of it.
 */
function keypairSigner(keypair: Keypair, server: rpc.Server, passphrase: string): WalletSigner {
  return {
    address: keypair.publicKey(),
    async signTransaction(transactionXdr: string): Promise<string> {
      const transaction = TransactionBuilder.fromXDR(transactionXdr, passphrase);
      transaction.sign(keypair);
      return transaction.toXDR();
    },
    async signAuthEntry(entryXdr: string): Promise<string> {
      const entry = xdr.SorobanAuthorizationEntry.fromXDR(entryXdr, "base64");
      const latest = await server.getLatestLedger();
      const signed = await authorizeEntry(entry, keypair, latest.sequence + 1_000, passphrase);
      return signed.toXDR("base64");
    },
  };
}

/** The raw 32-byte Ed25519 public key the contract registers for the agent. */
function rawPublicKeyHex(keypair: Keypair): string {
  return Buffer.from(StrKey.decodeEd25519PublicKey(keypair.publicKey())).toString("hex");
}

async function funded(
  server: rpc.Server,
  friendbotUrl: string,
  keypair: Keypair,
  label: string,
): Promise<void> {
  try {
    await server.getAccount(keypair.publicKey());
    step(`    ${label} already funded  ${keypair.publicKey()}`);
    return;
  } catch {
    // Not funded yet, which is the normal state on a fresh standalone network.
  }

  const response = await fetch(`${friendbotUrl}?addr=${encodeURIComponent(keypair.publicKey())}`);
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `the local friendbot refused to fund ${keypair.publicKey()} (HTTP ${response.status})` +
        `${detail ? `: ${detail.slice(0, 200)}` : ""}`,
    );
  }
  // Confirm the funding actually landed rather than trusting the faucet's reply.
  await server.getAccount(keypair.publicKey());
  step(`    ${label} funded              ${keypair.publicKey()}`);
}

// ── the local instance ──────────────────────────────────────────────────────

/**
 * The local network's latest ledger, or an error that says what to do about it.
 *
 * Reaching the RPC is the first thing that can fail in an obvious way, so it gets
 * its own message rather than an SDK stack trace about a refused connection.
 */
async function latestLedgerOrExplain(server: rpc.Server, rpcUrl: string): Promise<number> {
  try {
    const latest = await server.getLatestLedger();
    return latest.sequence;
  } catch (error) {
    throw new Error(
      `could not reach the local RPC at ${rpcUrl} (${
        error instanceof Error ? error.message : String(error)
      }). Start it with scripts/start-local-sandbox.sh.`,
    );
  }
}

async function contractExists(server: rpc.Server, contractId: string): Promise<boolean> {
  try {
    const instance = (await server.getContractInstance(contractId)) as unknown;
    return instance !== null && instance !== undefined;
  } catch {
    return false;
  }
}

async function deploy(params: {
  server: rpc.Server;
  signer: WalletSigner;
  passphrase: string;
  salt: Uint8Array;
  wasm: Uint8Array;
  predicted: string;
}): Promise<void> {
  const { server, signer, passphrase, salt, wasm, predicted } = params;

  const present = await artifactCodePresent(server, PHASE1_ARTIFACT.wasmHash);
  if (!present.ok) {
    throw new Error(
      `could not read the local code entry for the pinned artifact: ${present.error}`,
    );
  }

  if (present.value) {
    step("    the pinned bytecode is already a live code entry on this network");
  } else {
    const upload = await submitOperation({
      server,
      signer,
      operation: Operation.uploadContractWasm({ wasm }),
      passphrase,
    });
    step(`    upload_contract_wasm (${wasm.length} bytes): ${outcome(upload)}`);
    if (upload.kind !== "submitted") {
      throw new Error(`the upload did not land, so there is nothing to create: ${outcome(upload)}`);
    }
  }

  const create = await submitOperation({
    server,
    signer,
    operation: Operation.createCustomContract({
      address: Address.fromString(signer.address),
      wasmHash: hexToBytes(PHASE1_ARTIFACT.wasmHash),
      salt,
      constructorArgs: [],
    }),
    passphrase,
  });
  step(`    create_custom_contract → ${predicted}: ${outcome(create)}`);
  if (create.kind !== "submitted") {
    throw new Error(`the guard was not created: ${outcome(create)}`);
  }
}

// ── env file ────────────────────────────────────────────────────────────────

async function readEnvFile(path: string): Promise<Map<string, string>> {
  const values = new Map<string, string>();
  // `.catch()` rather than try/catch so `raw` is a single binding: a missing env
  // file is the normal first-run state, not an error.
  const raw = await readFile(path, "utf8").catch(() => null);
  if (raw === null) return values;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index > 0) values.set(trimmed.slice(0, index), trimmed.slice(index + 1));
  }
  return values;
}

/**
 * Write the sandbox's env values, keeping everything already in the file.
 *
 * The merge is deliberate: `.env.local` is the contributor's file, and a value
 * they added for their own work must not be dropped because a script rewrote it.
 */
async function writeEnvFile(path: string, updates: Map<string, string>): Promise<void> {
  const values = await readEnvFile(path);
  for (const [key, value] of updates) values.set(key, value);
  const body = [...values].map(([key, value]) => `${key}=${value}`);
  await writeFile(path, [...ENV_HEADER, ...body, ""].join("\n"));
}

// ── main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }

  const friendbotUrl = options.friendbotUrl ?? new URL("/friendbot", options.rpcUrl).toString();
  const local = createServer(options.rpcUrl);
  const artifactServer = createServer(options.artifactRpcUrl);

  // ── 1. the pin, re-derived from where Phase 1 proved it ─────────────────
  step("[1/6] pinned artifact, fetched from public testnet and verified");
  const wasm = await fetchContractWasm(artifactServer, options.artifactSource);
  const verification = await verifyGuardWasm(wasm, PHASE1_ARTIFACT.wasmHash);
  step(`    source       ${options.artifactSource} (${options.artifactRpcUrl})`);
  step(`    fetched      ${verification.actual} (${wasm.length} bytes)`);
  step(`    pinned       ${verification.expected} (${PHASE1_ARTIFACT.wasmBytes} bytes)`);
  if (!verification.ok || wasm.length !== PHASE1_ARTIFACT.wasmBytes) {
    throw new Error(
      "the bytes at the artifact source are not the pinned artifact — refusing to deploy anything locally",
    );
  }

  // ── 2. the local network, and the keypairs it will hold ────────────────
  step(`[2/6] local network ${options.rpcUrl}`);
  step(`    reachable, latest ledger ${await latestLedgerOrExplain(local, options.rpcUrl)}`);
  step(`    passphrase   ${options.passphrase}`);
  step(`    friendbot    ${friendbotUrl}`);

  const env = options.envOut ? await readEnvFile(options.envOut) : new Map<string, string>();
  const existingAdmin = options.secret ?? env.get("SAG_LOCAL_ADMIN_SECRET") ?? null;
  const existingAgent = env.get("SAG_LOCAL_AGENT_SECRET") ?? null;
  const admin = existingAdmin ? Keypair.fromSecret(existingAdmin) : Keypair.random();
  const agent = existingAgent ? Keypair.fromSecret(existingAgent) : Keypair.random();
  step(
    `[3/6] keypairs (${existingAdmin ? "reused admin" : "new admin"}, ${existingAgent ? "reused agent" : "new agent"})`,
  );
  await funded(local, friendbotUrl, admin, "admin");
  await funded(local, friendbotUrl, agent, "agent");

  // ── 3. deploy, at an address known before anything is signed ───────────
  const salt = createHash("sha256").update(SALT_SEED).digest();
  const predicted = await predictContractId({
    deployerPublicKey: admin.publicKey(),
    salt,
    passphrase: options.passphrase,
  });
  step(`[4/6] deploy`);
  step(`    predicted guard ${predicted}`);

  // One signer for both writes, so the sequence number the SDK reads is read once.
  const signer = keypairSigner(admin, local, options.passphrase);
  if (await contractExists(local, predicted)) {
    step("    already deployed on this network — reusing it");
  } else {
    await deploy({ server: local, signer, passphrase: options.passphrase, salt, wasm, predicted });
  }

  const identity = await verifyWasmIdentity(local, predicted);
  step(`    instance runs ${identity.fetchedSha256} (${identity.bytes} bytes)`);
  if (
    identity.fetchedSha256 !== PHASE1_ARTIFACT.wasmHash ||
    identity.bytes !== PHASE1_ARTIFACT.wasmBytes
  ) {
    throw new Error(
      `the local instance does not run the pinned artifact (${identity.fetchedSha256}, ${identity.bytes} bytes)`,
    );
  }

  // ── 4. register the admin and the agent on the account ─────────────────
  step("[5/6] initialize(admin, agent)");
  const agentPubkeyHex = rawPublicKeyHex(agent);
  if (await isInitialized(local, predicted)) {
    step("    already initialized — reusing the registered keys");
  } else {
    const result = await initializeGuard({
      server: local,
      signer,
      guard: predicted,
      agentPubkeyHex,
      passphrase: options.passphrase,
    });
    step(`    → ${outcome(result)}`);
    if (result.kind !== "submitted") {
      throw new Error(`initialize did not land: ${outcome(result)}`);
    }
  }

  // ── 5. point the console at it ─────────────────────────────────────────
  if (options.envOut) {
    await writeEnvFile(
      options.envOut,
      new Map([
        ["NEXT_PUBLIC_RPC_URL", options.rpcUrl],
        ["NEXT_PUBLIC_NETWORK_PASSPHRASE", options.passphrase],
        ["NEXT_PUBLIC_NETWORK_NAME", "local"],
        ["NEXT_PUBLIC_ARTIFACT_SOURCE_CONTRACT_ID", predicted],
        ["NEXT_PUBLIC_GUARD_CONTRACT_ID", predicted],
        ["SAG_LOCAL_ADMIN_SECRET", admin.secret()],
        ["SAG_LOCAL_AGENT_SECRET", agent.secret()],
      ]),
    );
    step(`[6/6] wrote ${options.envOut}`);
  } else {
    step("[6/6] --no-env: no env file written");
  }

  step("");
  step("Local sandbox ready.");
  step(`  rpc            ${options.rpcUrl}`);
  step(`  passphrase     ${options.passphrase}`);
  step(`  guard          ${predicted}`);
  step(`  admin          ${admin.publicKey()}`);
  step(`  agent          ${agent.publicKey()}`);
  step("");
  step("  These are throwaway local-network keys, written to the gitignored env");
  step("  file. Never reuse them, and never fund them on any other network.");
}

main().catch((error: unknown) => {
  console.error(`\ndeploy-local: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

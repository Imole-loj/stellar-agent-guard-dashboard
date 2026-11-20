# Contributing

`stellar-agent-guard-dashboard` is the operator console: a pure client-side Next.js app
that holds no keys and runs no server code, so most changes are UI, client-side Soroban
RPC, or tests.

## First run (local development walkthrough)

This is a pure client-side Next.js app: there is no backend, database or API route to
start, and no secret is required. The only network dependency is Soroban RPC; a wallet is
needed only to _write_.

### 1. Toolchain

Node 24+ is required (`package.json` → `engines.node`), and `.nvmrc` pins the major:

```bash
nvm use             # reads .nvmrc (24)
node -v             # v24.x
```

`nvm` is optional — any Node 24+ install works. Docker is only needed for
`npm run sandbox`.

### 2. Install exactly what the lockfile says

```bash
npm ci
```

**You should see:** the command exit 0 after installing the packages in
`package-lock.json`. `npm ci` fails when the lockfile and `package.json` disagree; that
failure is real and is fixed in the branch, never bypassed with `npm install` (see the
lockfile ride-along rule below).

### 3. Configure the network (optional)

An empty `.env.local` is a working public-testnet console: every variable has a default in
`lib/guard/network.ts`. To start from the documented template:

```bash
cp .env.example .env.local
```

Uncomment only what you need. `NEXT_PUBLIC_*` values are inlined by Next at build time, so
restart the dev server after editing. `.env.local` is gitignored; never put a real key in
it — this console is non-custodial and needs none.

### 4. Start the console

```bash
npm run dev
```

**You should see:** the dev server report `Ready` on <http://localhost:3000>. The overview's
status panel is honest in three states: a live value read from the chain, a pending
skeleton while the read is in flight, or a _named read error_. A failed read is never
rendered as `0`.

No wallet? The console stays in observer mode: reads, telemetry and the storage explorer
work, and write controls explain that a wallet is required. For a fully offline tour:

```bash
npm run dev:demo
```

**You should see:** the `DEMO MODE — Static Fixture Data` badge, a seeded telemetry feed,
and disabled write controls (demo fixtures never touch RPC).

### 5. Connect a wallet (only for writes)

Install [Freighter](https://www.freighter.app/), switch it to **Testnet**, then connect
from the wallet bar. **You should see:** your `G…` address and the network name, with write
controls enabled. A wallet on another network is reported as a mismatch and cannot sign;
switch networks in the wallet, then reconnect.

### 6. Run the gates

See [Local gates before pushing](#local-gates-before-pushing) and run every gate before
opening a PR.

### Common first-run failures

| Symptom                                                | Cause and fix                                                                                                                                                                             |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Error: listen EADDRINUSE … :3000`                     | Another dev server is already running. Stop it, or use another port: `npm run dev -- -p 3001` (then open <http://localhost:3001>).                                                        |
| `npm ci` fails on `engines` or an `EBADENGINE` warning | Node is older than 24. Run `nvm use`, or install Node 24+, then run `npm ci` again.                                                                                                       |
| The status panel says a read failed                    | The RPC endpoint is unreachable or rate-limited. Check `.env.local`'s `NEXT_PUBLIC_RPC_URL` and public-testnet status; the panel's per-read retry re-runs only the failed read.           |
| The wallet is connected but write buttons are disabled | Freighter is on a different network. Switch it to Testnet; the mismatch banner links to the same guidance.                                                                                |
| `/configure` shows an artifact as `unreadable`         | The pinned artifact could not be verified through RPC. Reads and the form still work, but deployment is refused until the read succeeds — that refusal is the safety property, not a bug. |

## Shared conventions

Commit style, the one-commit-per-logical-unit **per file** rule, the branch lifecycle
(feature branch → PR → delete after merge, `main` only), and the issue label taxonomy are
defined once for this org in the
[`stellar-agent-guard-sdk` CONTRIBUTING.md](https://github.com/aigbagbobila/stellar-agent-guard-sdk/blob/main/CONTRIBUTING.md).
Read that first; this page only adds what is specific to the dashboard.

## Local gates before pushing

```bash
npm ci
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm run format:check # prettier --check (npm run format rewrites the tree)
npm test            # node --test (unit suite)
npm run test:e2e    # Playwright browser suites (npx playwright install chromium first)
npm run build       # Next.js production build
npm run check:docs-scripts  # validates README.md + CONTRIBUTING.md references
```

What each gate is for — a failure names the gate that caught it, so this table is the
single home for the explanations rather than a second copy elsewhere in the docs:

| Gate                         | Catches                                                                                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`          | Type drift the bundler would otherwise erase: a changed SDK return shape, a prop that no longer exists, a narrowed union.                     |
| `npm run lint`               | React/Next hook-order problems, unused imports, and the repository's module-boundary rules.                                                   |
| `npm run format:check`       | Stylistic drift Prettier owns; a format failure is retried with `npm run format`, not hand-edited.                                            |
| `npm test`                   | Unit and fuzz behaviour: encoders/decoders, policy validation, race handling, component wiring (the suite runs each file in its own process). |
| `npm run test:e2e`           | Real browser flows against a mocked chain: guard lifecycle, policy writes, telemetry filtering/export.                                        |
| `npm run build`              | Production compilation, route rendering and the static-export boundary.                                                                       |
| `npm run check:no-server`    | An accidental route handler, middleware file or server action — the zero-backend boundary is architectural.                                   |
| `npm run test:docs`          | Broken relative links and section anchors in Markdown.                                                                                        |
| `npm run check:docs-scripts` | A `npm run …` reference in README/CONTRIBUTING whose script no longer exists.                                                                 |

### Visual regression baselines

`npm run test:visual` compares the console against committed Playwright snapshots at the
designed viewports (desktop 1440, tablet 768, mobile 375 in dark and light), plus three
viewport-sized responsive captures from `tests/visual/responsive.spec.ts`: `/configure` at
375×667 and 1280×800, and `/` at 1280×800 (issue #39). A difference means the interface
changed; the report in `playwright-report/` contains the diff.

**Baselines are generated only in CI**, inside the pinned
`mcr.microsoft.com/playwright:v1.64.0-noble` image. That image fixes both the browser
build and the font set, so a comparison cannot fail because a contributor's OS renders
fonts differently. To refresh the committed files, push a commit whose message contains
`update-screenshots`; the `update-screenshots` job in
[`.github/workflows/visual-tests.yml`](./.github/workflows/visual-tests.yml) rebuilds the
app inside the image, runs `--update-snapshots`, and pushes the refreshed files back to
the branch.

Do **not** commit the output of `npm run test:visual:update` from a developer machine.
It uses local fonts and produces exactly the cross-OS drift these snapshots exist to
catch, and the next CI run would diff against pixels it cannot reproduce. The tolerance
(`maxDiffPixelRatio: 0.005`, with the rationale for that value) is documented once beside
the assertion config in [`playwright.visual.config.ts`](./playwright.visual.config.ts).

These extra scripts are not part of the CI gate:

- `npm run prove:phase3` — re-runs the live testnet proof against the real deployed
  contract; needs funded testnet keypairs.
- `npm run prove:phase3:emit` / `npm run prove:phase3:diff` — the same run, plus the
  narrow diffable run record and the two-tier diff against its committed copy.
  The shape, the rule and the diff tool are unit-tested; the run itself still
  needs funded testnet keys. See
  [`tests/fixtures/README.md`](./tests/fixtures/README.md#re-running-and-diffing-a-re-run-against-this-record).
- `npm run inspect` — read-only dump of a deployed instance's on-chain state.
- `npm run test:perf` — the telemetry throughput benchmark (`tests/perf`, 10k
  events in 30s with FPS/heap assertions); frame-rate numbers depend on the
  runner's hardware, so it is measured locally and never gates a merge.

### Lockfile ride-along rule

`package-lock.json` is committed and is the reproducibility contract (`npm ci` is the
gate that proves it). Lockfile changes therefore ride along with the PR that caused
them — a dependency-adding or dependency-bumping PR commits its own lockfile diff in
the same commit — and separate lockfile-only PRs are not opened. The same applies to
`npm audit fix` output: run it as part of the change that motivates it, never as a
standalone lock churn. Never run `npm audit fix --force` (it can jump majors); a fix
that requires a breaking upgrade is its own issue, argued on its own.

Two more are tooling rather than gates, both described below:

- `npm run format` — rewrite the repository with Prettier.
- `npm run changelog` — regenerate `CHANGELOG.md` from conventional commits.

### Script audit inventory

The mini checker enforces the asymmetric rule: a script referenced in docs must exist,
while extra scripts are reported as informational rather than failing CI. Scripts that
the docs reference only through the bare `npm test` form are not counted by the checker
(it matches `npm run …` literally) but are listed here for completeness. The current
inventory is:

| Script                                    | Documented in README/CONTRIBUTING                               | Verdict                                                                |
| ----------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `dev`                                     | Yes — quick start                                               | documented                                                             |
| `dev:demo`                                | Yes — demo mode section                                         | documented                                                             |
| `build`                                   | Yes — verification block                                        | documented                                                             |
| `lint`                                    | Yes — verification block                                        | documented                                                             |
| `typecheck`                               | Yes — verification block                                        | documented                                                             |
| `check:docs-scripts`                      | Yes — this section and the Documentation links section          | documented                                                             |
| `format`                                  | Yes — lockfile section                                          | documented                                                             |
| `changelog`                               | Yes — lockfile section and Changelog section                    | documented                                                             |
| `test:docs`                               | Yes — Documentation links section                               | documented                                                             |
| `sandbox`                                 | Yes — Local sandbox section                                     | documented                                                             |
| `test:e2e`                                | Yes — verification block, branch-protection section             | documented                                                             |
| `test:perf`                               | Yes — extra scripts note                                        | documented                                                             |
| `prove:phase3`                            | Yes — extra scripts note                                        | documented                                                             |
| `prove:phase3:emit` / `prove:phase3:diff` | Yes — extra scripts note                                        | documented                                                             |
| `inspect`                                 | Yes — verification block and extra scripts note                 | documented                                                             |
| `test`                                    | Yes — verification block, but as `npm test` (bare `npm test …`) | informational (no `npm run test` reference yet)                        |
| `start`                                   | No                                                              | intentional-with-note (local runtime entrypoint, kept out of the docs) |
| `export`                                  | No                                                              | informational (static-export entrypoint, not user documentation)       |
| `test:visual` / `test:visual:update`      | Yes — Visual regression baselines                               | documented (baselines are regenerated in CI only)                      |

## Pre-commit hook

Husky installs a `pre-commit` hook on `npm install` (`prepare` in `package.json`), and
lint-staged runs it over **staged** files only — see `.husky/pre-commit`,
`.lintstagedrc.json` and `.prettierrc.json`:

| Staged files    | What runs                               |
| --------------- | --------------------------------------- |
| `*.ts`, `*.tsx` | `eslint --fix`, then `prettier --check` |
| `*.json`        | `prettier --check`                      |

`eslint --fix` repairs what it can and fails the commit on what it cannot. Prettier only
_checks_, so a formatting problem stops the commit with Prettier's own message instead of
being silently rewritten — run `npm run format` (or `npx prettier --write <file>`) and
commit again. `HUSKY=0 git commit …` bypasses the hook for a one-off emergency commit;
CI never runs it, because CI never commits.

Prettier is configured at `printWidth: 120`, matching the hand-written style already in
the repository, so the first format of a file should be close to a no-op. `package-lock.json`
and `tests/fixtures/phase3-proof.json` are generated and ignored (`.prettierignore`).

## Documentation links

`npm run test:docs` runs `scripts/check-doc-links.mjs`, which walks every `.md`/`.mdx`
file, extracts inline links, images, HTML `href`/`src` attributes and reference-style
definitions, and fails on a relative path that does not exist or a `#fragment` that is not
a heading in its target. It never makes a network request, so external URLs are skipped;
fenced code blocks, inline code spans and HTML comments are not scanned, which is why the
syntax can be documented without documenting itself. Anchor matching implements GitHub's
heading → anchor rules, including the double hyphen an em dash leaves behind.

CI runs it, so a broken cross-reference — a renamed heading, a moved file — fails the
build rather than quietly misleading a reader. Alongside it, `npm run check:docs-scripts`
validates every `npm run …` reference in README.md and CONTRIBUTING.md against the
scripts declared in `package.json` (see the [Script audit inventory](#script-audit-inventory)
section), so a doc reference to a script that does not exist fails the build too.

## Changelog

`CHANGELOG.md` is generated, not hand-edited:

```bash
npm run changelog                                  # rewrite CHANGELOG.md
node scripts/generate-changelog.mjs --stdout       # preview it
node scripts/generate-changelog.mjs --version 0.2.0 --date 2026-09-25
```

`scripts/generate-changelog.mjs` reads the commits since the last release tag (or the
whole history when nothing has been tagged), groups them into Features, Bug Fixes,
Documentation and Maintenance, links `#123` references to the issue, and renders
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) Markdown. A commit only appears
if it declares a type, so merging a PR with a proper commit subject is what puts it in the
changelog; commits that do not parse are counted and reported, never silently rendered as
something they are not. `tests/unit/changelog.test.ts` covers the parsing and rendering.

## Local sandbox

For offline development — no public testnet, no browser wallet required for reads —
`scripts/start-local-sandbox.sh` boots a local standalone Stellar/Soroban network in
Docker, deploys the pinned guard artifact to it, and points the console at it:

```bash
npm run sandbox        # first run pulls the stellar/quickstart image
npm run dev            # restart the dev server if it was already running
# open http://localhost:3000

npm run sandbox -- --down   # stop the network and remove the container
```

Requirements: Docker (with a reachable daemon) and Node 24+. The script, in order:

1. checks that Docker is installed and that its daemon answers;
2. starts an ephemeral `stellar/quickstart` container publishing port 8000, with
   `--local --enable core,horizon,rpc` (override with `SAG_SANDBOX_FLAGS`);
3. waits for the RPC to answer, probing both `/soroban/rpc` and `/rpc` — the RPC path
   moved between quickstart image generations and whichever responds is the one recorded;
4. runs `scripts/deploy-local.ts`, which fetches the pinned artifact's bytes from public
   testnet, checks they hash to the pin (`f47919…`, 39673 bytes), uploads those exact
   bytes to the local network, creates the guard at the address predicted from a fixed
   salt _before_ signing, and re-reads the instance to confirm it runs them;
5. funds a throwaway local admin keypair and agent keypair from the local friendbot and
   calls `initialize(admin, agent)`;
6. writes `.env.local` and prints the addresses.

`.env.local` (gitignored) is what moves the console:

| Variable                                           | Effect                                                      |
| -------------------------------------------------- | ----------------------------------------------------------- |
| `NEXT_PUBLIC_RPC_URL`                              | the RPC endpoint the console reads and broadcasts to        |
| `NEXT_PUBLIC_NETWORK_PASSPHRASE`                   | the passphrase transactions and auth entries are signed for |
| `NEXT_PUBLIC_NETWORK_NAME`                         | the network name shown in the wallet-mismatch message       |
| `NEXT_PUBLIC_ARTIFACT_SOURCE_CONTRACT_ID`          | the instance the pinned bytes are read from                 |
| `NEXT_PUBLIC_GUARD_CONTRACT_ID`                    | the guard the selector opens on                             |
| `SAG_LOCAL_ADMIN_SECRET`, `SAG_LOCAL_AGENT_SECRET` | the throwaway local keypairs                                |

`lib/guard/network.ts` and `lib/guard/instance.ts` read these with public testnet as the
default, so an ordinary build is unchanged. What they cannot change is the artifact pin:
the hash and byte length are constants, and the deploy flow refuses any bytecode that does
not match them, whichever instance it was read from. These are public endpoints (plus two
local-only test secrets) and are never required in CI or in a deployment.

Caveats worth knowing, since the rest of this repository is explicit about proof:

- the container is ephemeral, so stopping it discards the local ledger; re-running the
  script redeploys the _same_ guard address, because the salt is fixed;
- the local friendbot and accounts are throwaway. Never reuse those keys, and never fund
  them on another network;
- write actions still need Freighter, pointed at the local network. Reads, telemetry and
  the deploy script itself work without any wallet.

## Branch protection and CI

`main` is protected by the `main-protection` ruleset, and the required status check is
named exactly **`ci`**. The `ci` workflow runs typecheck, lint, the unit tests, the
production build, a dedicated step that re-checks the enforcement-scope statement in
`README.md` and `SPEC.md` against the canonical constant in `lib/guard/network.ts`
(`tests/unit/scopeStatement.test.ts`), and the Playwright end-to-end suites
(`npm run test:e2e`, headless Chromium against a mocked chain). Rewording the boundary fails CI, which is the
point — see [Enforcement scope](README.md#enforcement-scope--read-this-before-relying-on-the-caps).

## Keeping docs true to the code

Two documentation rules are part of the review, not optional polish:

- **README claims are tracked, not asserted.** The top-level `README.md` describes what the console can
  do. Every behaviour claim there has a row in [`docs/readme-claims.md`](./docs/readme-claims.md) with
  the file or test that evidences it. When you add, rename or remove a screen, panel, script or
  capability bullet, update the matching row (and its "Last verified" date) in the same commit; a claim
  with no evidence row is treated as a stale claim.
- **State-model changes update `SPEC.md`.** The derived-vs-stored table and the write-surface inventory
  in [`SPEC.md` §8](./SPEC.md) are normative. If a change adds a persisted key, changes what is read from
  the chain, adds a write path, or changes when a value refreshes, update that table in the same change —
  the model and the code move together. This is this repo's adaptation of the contracts repo's "code and
  spec co-move" rule to a client-side app.

## Supply chain

Workflow actions are pinned to full commit SHAs with a readable version comment, and every workflow
declares the least-privilege `permissions:` it needs. Do not replace a SHA pin with a moving tag, and
do not add a `uses:` without a pin. [`dependabot.yml`](./.github/dependabot.yml) opens the reviewable
bumps for both `github-actions` and `npm`.

## Issues

- Backlog: <https://github.com/aigbagbobila/stellar-agent-guard-dashboard/issues>
- The org-wide `tier:` / `scope:` label taxonomy is described in the shared
  CONTRIBUTING.md linked above; this repo's scope label is `scope:dashboard`.

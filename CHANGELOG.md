# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and entries are
derived from [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) by
`npm run changelog`.

## [Unreleased]

### Features

- **policy**: include network identity and preview imports before applying a draft (Closes #298)

- **guard**: add rotateAgentKey operation function (`552f76b`)
- **scripts**: read-only instance inspector (`e4e55b6`)
- **ui**: deploy and configure page (`f8f7a08`)
- **ui**: console page (`ffe78f1`)
- **ui**: root layout (`28d7430`)
- **ui**: real deployment with pinned-artifact verification (`28ccf0b`)
- **ui**: no-code guardrail configurator (`429b5b5`)
- **ui**: emergency freeze with confirmed on-chain effect (`54dd336`)
- **ui**: live event feed over the guard's real topics (`49066f1`)
- **ui**: live on-chain state, policy and artifact identity (`e24378d`)
- **ui**: wallet connection and guarded-account selection (`5d61de9`)
- **ui**: wallet, instance, snapshot and telemetry state (`d3cbf39`)
- **ui**: shared pieces including the enforcement-scope notice (`06d745a`)
- **guard**: Freighter adapter implementing the signer seam (`4074e96`)
- **guard**: instance selection carrying provenance (`8f1c537`)
- **guard**: cursor-carrying telemetry feed (`44e18c5`)
- **guard**: deploy, initialize, policy and freeze operations (`7d02acf`)
- **guard**: no-code policy form model and local validation (`5db1e8d`)
- **guard**: wallet-signed simulate, sign, enforce and submit pipeline (`851b81d`)
- **guard**: read-only chain access with explicit failures (`b60614b`)
- **guard**: isomorphic XDR and ledger-key helpers (`291be1a`)
- **guard**: network, artifact and enforcement-scope constants (`a00c149`)
- harden response headers on a console that holds no keys (`a8a45be`)
- scaffold the operator console package (`fbe2463`)

### Bug Fixes

- **scval**: support Node webcrypto fallback in test environment (`fb19725`)

### Documentation

- remove Phase 2 gate section from spec (`5450239`)
- correct Phase 2 publish status (`68f9f0f`)
- **site**: point the contributing page at the dashboard's own guide (`8981f8b`)
- **readme**: link contributing to the dashboard's own guide (`8c901d9`)
- **contributing**: add the dashboard's own contributing guide (`9598e50`)
- **readme**: update README to full playbook parity (`9df86da`)
- **site**: document frequently asked questions (`e90a1df`)
- **site**: document contributing guide and issue backlog (`f39529a`)
- **site**: document SAC vs non-SAC enforcement scope (`2d4fc9b`)
- **site**: document testnet verification proof (`0e7b6c8`)
- **site**: document 3-repo system architecture (`680417e`)
- **screens**: document live telemetry feed component (`b5f1b3c`)
- **screens**: document panic button and emergency freeze flow (`14aca49`)
- **screens**: document deploy panel component (`ace1630`)
- **screens**: document policy configurator screen (`a25a97d`)
- **screens**: document console overview screen (`041aec8`)
- **concepts**: document live Soroban RPC state querying (`287b0cc`)
- **concepts**: document admin vs dead-man freeze semantics (`de5ee93`)
- **concepts**: document on-chain bytecode verification and pinning (`5110e6a`)
- **concepts**: document client-side Freighter architecture (`f7d4edf`)
- **site**: add installation and setup page (`090d38e`)
- **site**: add introduction page (`ac3d655`)
- **site**: add GitBook documentation summary (`d30be88`)
- **banner**: add Stellar Agent Guard banner image (`53a28c4`)
- console README with scope framing and gate status (`10d4c1f`)
- architecture and consumer contract for the console (`5e0f684`)
- evidence record for the Phase 3 run (`1fe5ea9`)

### Maintenance

- **fixtures**: refresh live testnet Phase 3 panic button proof (`745e718`)
- **guard**: add unit tests for rotateAgentKey function (`3c92b53`)
- add static Vercel deployment workflow (`5cb72c6`)
- **lock**: update lockfile for npm published SDK package and tsx (`9135feb`)
- **deps**: swap vendored tarball for published stellar-agent-guard-sdk package (`0f66b2e`)
- **package**: declare the MIT license in package.json (`3e86cea`)
- **license**: add the MIT LICENSE file the README already links to (`a64cc9f`)
- **docs**: add GitBook site configuration (`b14dedb`)
- typecheck, lint, unit tests and build (`1cc5aba`)
- **docs**: guard the enforcement-scope statement against drift (`5bbf037`)
- **guard**: cover rejection diagnostics (`dcc08f6`)
- **guard**: cover policy validation and encoding (`9f95fb8`)
- **guard**: cover the isomorphic byte and ledger-key helpers (`eea2920`)
- **proof**: record the Phase 3 on-chain evidence (`838317f`)
- **proof**: end-to-end Phase 3 run against testnet (`31117cd`)
- add the console stylesheet (`ce712f9`)
- vendor the Phase 2 SDK tarball (`778c3e5`)
- add the Next flat ESLint preset as the CI lint gate (`1a5aaf3`)
- configure TypeScript for the App Router and strippable sources (`bcf11dc`)
- lock the dependency tree (`3ce65e5`)
- ignore build output, caches and local env files (`0c3b0d2`)
- throwaway commit to verify ruleset bypass (phase 0) (`d97dd5b`)
- initial scaffold (phase 0) (`243be6f`)

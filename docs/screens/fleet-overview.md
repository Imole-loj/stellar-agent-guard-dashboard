# Fleet Overview Screen (`/fleet`)

The Fleet Overview provides multi-guard monitoring and management across all registered guards in the operator's browser registry.

## Key Capabilities

### 1. Preserved Operator Column Layout (#476)
- **Column Customization**: Operators can customize which columns are visible (`Selection`, `Guard`, `Network`, `Status`, `24h Spend`, `DMS Countdown`, `Actions`) and adjust column ordering.
- **Strict Boundary**: Core identifier columns (`Selection`, `Guard`) remain mandatory to maintain operational accessibility.
- **Persistence**: Presentation preferences are persisted exclusively under `stellar-agent-guard-dashboard.fleet-columns.v1` in `localStorage`. No blockchain or registry state is modified.
- **Factory Reset**: A single-click reset restores the default layout order and visibility.

### 2. Multi-Guard Policy Review Report (#477)
- **Forensic Policy Export**: Generates an authoritative snapshot report of current policies across all fleet members.
- **Explicit Failure Distinction**: Guard reads that fail (due to network timeout, missing contract, or RPC errors) are prominently flagged as `failed` with error details. Failed reads are **never** presented as empty policies or default-deny configurations.
- **Partial Report Flag**: If any guard read fails, the report is marked as `isPartial: true` with a clear audit warning banner.
- **Export Formats**: Operators can inspect live summaries in a modal or export to standard Markdown (`.md`) for auditing.

### 3. Absent Guard Registration (#478)
- **Browser-Local Registry Model**: Fleet membership is browser-local. Guards only appear in the dashboard if registered in the current browser's local registry.
- **Clear Separation**: Registering an address saves it locally in browser storage. It does **NOT** deploy, verify, or mutate any contract on-chain.
- **Validation**: Accepts any valid 56-character Soroban contract address (`C...`) validated by StrKey checksum.

### 4. Guarded Local Registry Merge Preview (#479)
- **Safe Import Preview**: When importing registry entries from JSON, changes are analyzed in a pure preview before writing to local storage.
- **Classification**:
  - **Additions**: New valid guard addresses.
  - **Conflicts**: Existing addresses with differing labels or network designations, requiring explicit operator confirmation before updating.
  - **Skips**: Exact duplicates and duplicate entries within the batch.
  - **Invalid**: Malformed JSON or invalid contract addresses, reported with actionable error reasons.
- **Zero-Write Cancellation**: Cancelling the preview leaves the browser's registry completely untouched.

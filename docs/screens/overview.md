# Overview Screen (`/`)

The primary console screen provides full visibility into the active guard account:

- **Wallet Header**: Displays connected Freighter address, testnet connection status, and quick-disconnect.
- **Account Summary**: Shows guard custom account address, SAC token balance, and policy summary string.
- **Dead-Man Switch Status**: Displays countdown timer until the agent's heartbeat grace period expires.
- **Panic Button**: Immediate access to the emergency freeze modal.
- **Telemetry Feed**: Live scrolling feed of recent `event_auth_checked` authorization events.
- **Incident Actions**: The admin writes worth doing to this account in the state the chain reports,
  each with what it does and the confirmation the existing control asks for; anything not offered is
  listed with its reason rather than left out. Rows hand off to the control that performs the write —
  they focus it, never click it — and a separate block re-reads `status()` once, on demand, to answer
  whether the write landed. See
  [the incident action list](../../SPEC.md#the-incident-action-list-on-the-overview).
- **Refresh Strip**: One row, on the single line the site header sets aside for it, per panel that
  polls, stating its cadence, when its last round landed, and whether it is `polling`, `connecting`,
  `poll failing`, `no response` or `stopped`. The strip reads nothing itself — panels report their own
  liveness and withdraw it when they unmount — and a frozen display is shown as `display paused` beside
  the phase rather than in place of it. The line is reserved whether or not anything has published yet,
  so the panels below it never move when the first round lands; a strip with more rows than width
  scrolls sideways. Each row links to that panel's diagnostics. See
  [the read path](../../SPEC.md#where-the-console-says-when-it-last-read).

# Security

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private vulnerability
reporting on this repository ("Security" tab, "Report a vulnerability"). You
will get an answer within a week. Fixes for confirmed issues are released as
soon as they are ready, with credit to the reporter if they want it.

## What faztudo protects

faztudo runs agent command line tools on your machine on your behalf. The
design assumes that agents make mistakes and that messages from outside
(Signal, Discord, the local network) can be hostile.

- **Local by default.** The server listens on `127.0.0.1:7457` unless you
  turn on LAN mode. Loopback stays open alongside LAN mode (`0.0.0.0:7458`)
  and continues to sign in the local user automatically.
- **LAN mode requires TLS and a session.** On first LAN start, faztudo creates
  a local ECDSA P-256 CA (10 years) and server certificate (1 year) in
  `~/.local/share/faztudo/tls/` (directory `0700`, private keys `0600`) with
  SANs for the hostname, `hostname.local`, `localhost`, and every non-loopback
  interface address. If the address set changes on a later start, the server
  certificate is regenerated. A plain-HTTP helper on port `7459` serves only a
  page with `/ca.crt` and its SHA-256 fingerprint so you can verify and
  install the CA on your phone.
- **No anonymous LAN access.** LAN mode refuses to start if no password has
  been set with `faztudo passwd` and no device is paired. Passwords are stored
  only as `bcrypt` hashes (cost 12) in SQLite and are never logged. Login is
  rate-limited to 5 failed attempts per 15 minutes per remote address (HTTP
  429). Pairing tokens (`POST /api/v1/auth/pairings`, callable from loopback
  only) are 128-bit random values, stored as SHA-256 hashes, valid for 5
  minutes, and burned on first use whether pairing succeeds or not. Sessions
  use 32-byte random tokens stored as SHA-256 hashes in the `sessions` table
  and sent in the `fz_session` cookie (`HttpOnly`, `Secure`,
  `SameSite=Strict`, `Path=/`, 30-day sliding expiry). Revoking a device
  (`DELETE /api/v1/auth/devices/{id}`) drops its session and closes its open
  WebSocket connections immediately.
- **Request safety on LAN.** Every state-changing request (`POST`, `PATCH`,
  `DELETE`) and every WebSocket upgrade on the LAN listener must carry an
  `Origin` header matching `https://<Host>`. The `/mcp` endpoint is restricted
  to loopback connections only.
- **Approvals are human-only.** An agent can ask for approval but cannot grant
  it. The server decides who is acting from the connection or authenticated
  session, never from the message content.
- **Isolated write runs.** An agent that changes code works in its own git
  worktree, not in your checkout. Pushing a branch, sending to a bridge and
  other actions that go through faztudo need an approval.
- **Honest limits.** An agent CLI runs as your user. faztudo cannot stop a
  CLI from doing what that CLI can do on its own; it starts each CLI in the
  strictest sandbox and permission mode the run allows, and can wrap write
  runs in a Linux sandbox (bubblewrap).
- **Stripped environment.** Agent processes start with known secret variables
  removed from their environment.
- **Bridges are allowlisted.** Signal and Discord accept messages only from
  identities you listed.

## Where secrets live

- Agent sign-ins stay with each agent CLI. faztudo does not read or copy them.
- Secrets that faztudo needs (for example a Discord bot token) are stored in
  the system keyring, or in `~/.config/faztudo/secrets` with mode 0600. faztudo
  refuses to start if that file can be read by other users.
- TLS private keys live in `~/.local/share/faztudo/tls/` with mode 0600 inside
  a 0700 directory. Passwords, session tokens, and pairing tokens are stored
  in SQLite as hashes only (`bcrypt` cost 12 for passwords, SHA-256 for
  tokens).
- Secrets are never written to the event log, run logs, or error messages.
- This repository contains no credentials. CI scans every commit with
  gitleaks.


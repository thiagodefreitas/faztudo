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
  rate-limited to 5 attempts per 15 minutes per remote address, counted before
  the password is checked and cleared by a correct login (HTTP 429).
  `faztudo passwd` signs out every device. `GET /api/v1/health` returns only
  `{"ok":true}` on the LAN listener. Pairing tokens (`POST /api/v1/auth/pairings`, callable from loopback
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
- **Write-run sandbox.** Opt in with `runs.sandbox = "auto"` or
  `"required"` (off by default until toolchains under your home can be
  made visible inside it). On Linux, write runs then use bubblewrap when
  unprivileged user namespaces work. The worktree and shared git directory
  are writable. System tools and a small set of `/etc` files are read-only.
  Only the selected CLI's own config and sign-in paths and its exact
  executable file are bound from your home. The rest of home, including
  `~/.ssh`, is hidden. SSH agent, desktop
  and DBus sockets are not bound. Network stays on by default so CLIs can
  reach their APIs; a lane turns it off with `sandbox_network = false`
  (default on). Where a systemd user scope works, it sets memory and task
  limits: `runs.sandbox_memory_max` (default `4G`) and
  `runs.sandbox_tasks_max` (default 512). Without a scope the run is still
  sandboxed, just without those limits. Run `faztudo doctor` to check
  bubblewrap, unprivileged user namespaces and systemd user scope
  availability.
- **Honest limits.** The sandbox shares the host kernel, and the CLI still
  runs as your user. It can change its worktree and git metadata, read and
  write its own bound sign-in and config files, and access the network when
  allowed. It does not
  isolate the CLI from another process running as your user. In `auto` mode,
  a missing or unusable sandbox falls back to an unsandboxed run with one
  channel notice. Set `runs.sandbox = "required"` to refuse that run instead.
  Read runs are unchanged. A sandboxed run ends if its parent exits; recovery
  records an interrupted run rather than resuming its process.
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


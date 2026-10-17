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

- **Local by default.** The server listens on 127.0.0.1 unless you turn on LAN
  mode. LAN mode requires TLS, a login, and per-device pairing.
- **Approvals are human-only.** An agent can ask for approval but cannot grant
  it. The server decides who is acting from the connection, never from the
  message content.
- **Isolated write runs.** An agent that changes code works in its own git
  worktree, not in your checkout. Pushing and other outward actions need an
  approval.
- **Stripped environment.** Agent processes start with known secret variables
  removed from their environment.
- **Bridges are allowlisted.** Signal and Discord accept messages only from
  identities you listed.

## Where secrets live

- Agent sign-ins stay with each agent CLI. faztudo does not read or copy them.
- Secrets that faztudo needs (for example a Discord bot token) are stored in
  the system keyring, or in `~/.config/faztudo/secrets` with mode 0600. faztudo
  refuses to start if that file can be read by other users.
- Secrets are never written to the database, the event log, run logs, or
  error messages.
- This repository contains no credentials. CI scans every commit with
  gitleaks.

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
  turn on LAN mode. Loopback stays open alongside LAN mode (`0.0.0.0:7458`).
  Local API requests need a bearer token or the `fz_local` browser cookie.
  `faztudo serve` creates a 32-byte token in the data directory as
  `local-token` (mode 0600). `faztudo open` opens a fragment URL that exchanges
  it for an HttpOnly, SameSite=Strict cookie; the token is not the cookie.
  `faztudo token --rotate` replaces it and invalidates existing local cookies.
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
- **Write-run sandbox.** `runs.sandbox = "auto"` is the default. On Linux,
  write runs use bubblewrap when unprivileged user namespaces work. The
  worktree is writable, except its `.git` file, which is read-only. The shared
  git directory is read-only except its objects. The run's worktree metadata
  is a private writable copy, and the run's own branch (`fz/<run id>`) lives in
  a private copy of its ref and reflog directory. The agent can commit on its
  branch inside the sandbox but cannot move `main`, any other branch or a tag;
  the merge flow recommits from the base commit, so host Git never reads that
  private copy. Host-side git commands on an agent worktree name the run's
  real git directory and work tree explicitly (`--git-dir`, `--work-tree`), so
  a `.git` file or repository the agent put in the worktree is never read, and
  neither is any filter, alias or config defined in it. They also disable
  fsmonitor, hooks, external diffs and textconv, and ignore system and global
  attributes. Before every diff, stage and merge, faztudo checks that the
  worktree's `.git` is still the exact file it wrote; if not, the run fails as
  tampered with and nothing is diffed or merged. Filter drivers can only come
  from your own git configuration (for example Git LFS), which the agent
  cannot write. The channel's test command runs in the same sandbox with a
  stripped environment.
  System tools and a small set of `/etc` files are read-only. Toolchain roots
  in home `PATH` entries named `bin`, `shims` or `scripts`, the Go module cache and paths in
  `runs.sandbox_read_only` are read-only. Go, npm and XDG caches use a private
  writable directory for this run. The selected CLI's config and sign-in
  paths are read-only, with writable per-run session directories and copies
  of session index files. Codex gets a `CODEX_HOME` of its own under the run's
  state directory: `config.toml`, `AGENTS.md`, `packages/`, `plugins/`,
  `skills/` and `rules/` are read-only binds of your `~/.codex` (or
  `$CODEX_HOME`), `auth.json` is the one writable host file, and everything
  else (sqlite databases, `tmp`, sessions) is fresh. Your Codex history,
  sessions and databases are not visible in the sandbox. Existing OAuth credential files are writable
  exceptions for Claude (`.claude/.credentials.json`), Codex
  (`.codex/auth.json`), Grok (`.grok/auth.json`), Kimi
  (`.kimi-code/credentials/*` and `.kimi-code/oauth/*`), Agy
  (`.gemini/antigravity-cli/antigravity-oauth-token`) and OpenCode
  (`.local/share/opencode/auth.json`). The rest of home,
  including `~/.ssh`, is hidden. SSH agent, desktop and DBus sockets are not
  bound. Network stays on by default so CLIs can reach their APIs; a lane
  turns it off with `sandbox_network = false`. Such a run gets no MCP config
  because it cannot reach the local endpoint. Where a systemd user scope
  works, it sets `runs.sandbox_memory_max` (default `4G`) and
  `runs.sandbox_tasks_max` (default 512). Without a scope the run is still
  sandboxed, just without those limits. Run `faztudo doctor` to check
  bubblewrap, unprivileged user namespaces and systemd user scope availability.
- **Honest limits.** The sandbox shares the host kernel, and the CLI still
  runs as your user. It can change its worktree, shared git objects (a bad
  object is only reachable through a ref, and refs are read-only), writable
  credential exceptions and session state, and access the network
  when allowed. Repository content and the channel test command remain
  untrusted, but execute inside the sandbox. Disabling host-side git hooks
  also means repository hooks do not protect merges from agent worktrees;
  review the diff before approving. Codex receives its per-run MCP bearer
  token through the process environment, not argv. It does not
  isolate the CLI from another process running as your user. In `auto` mode,
  a missing or unusable sandbox falls back to an unsandboxed run with one
  channel notice. Set `runs.sandbox = "required"` to refuse that run instead.
  Read runs are unchanged. A sandboxed run ends if its parent exits; recovery
  records an interrupted run rather than resuming its process.
- **Which CLIs run in the sandbox.** Claude: verified live (a write run that
  runs `go test` and `npm test`). Codex: given its own `CODEX_HOME` after it
  failed to start on the read-only `~/.codex`; the mount layout is tested with
  bubblewrap, and the model-backed run is the same live test. Grok, Kimi, Agy
  and OpenCode have their config read-only with per-run session directories;
  they keep more mutable state (databases, logs, caches) than that covers, so
  one may fail to start in the sandbox. None of those four has been checked
  live. Check one with `FAZTUDO_LIVE_SANDBOX=1 go test ./internal/runner -run
  TestLiveSandboxedCLIWriteRun -v`. The check at the start of every run only
  proves the CLI answers `--version` inside the mounts, so a CLI that fails
  later fails that run; it does not fall back to an unsandboxed one.
- **Stripped environment.** Agent processes start with known secret variables
  removed from their environment.
- **Local token limit.** An unsandboxed agent runs as you and can read the
  local token file. The token prevents a sandboxed agent or an unrelated local
  process without that file from acting as you; it does not isolate processes
  that already have your filesystem access.
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


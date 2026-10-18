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
- **Write-run sandbox.** `runs.sandbox = "required"` is the default in a
  new config: without bubblewrap and unprivileged user namespaces a write run
  fails at once with a notice that says why and how to opt into `"auto"`. On Linux,
  write runs use bubblewrap when unprivileged user namespaces work. The
  worktree is writable, except its `.git` file, which is read-only. The shared
  git directory is read-only except its objects; `objects/info` is read-only
  too, so a run cannot replace alternates or commit-graph metadata. The run's worktree metadata
  is a private writable copy, and the run's own branch (`fz/<run id>`) lives in
  a private copy of its ref and reflog directory. The agent can commit on its
  branch inside the sandbox but cannot move `main`, any other branch or a tag;
  the merge flow recommits from the base commit, so host Git never reads that
  private copy. Host-side git commands on an agent worktree name the run's
  real git directory and work tree explicitly (`--git-dir`, `--work-tree`), so
  a `.git` file or repository the agent put in the worktree is never read, and
  neither is any filter, alias or config defined in it. They also disable
  fsmonitor, hooks, external diffs and textconv, and ignore system and global
  attributes. They enumerate filter drivers in repo, global and system Git
  configuration and override their clean, smudge and process commands with
  empty values, including during worktree creation and the final host merge.
  Before every diff, stage and merge, faztudo checks the
  worktree's `.git` and the admin `commondir`, `gitdir` and `config.worktree`
  against the values it created; a changed pointer or new `config.worktree`
  fails as tampered with before any diff or merge. A repository that already
  requires per-worktree Git configuration cannot start a write run. The
  channel's test command runs in the same sandbox with a
  stripped environment.
- **AppArmor on Ubuntu 24.04 and newer.** The `.deb` installs a profile that
  allows user namespaces only for `/usr/bin/bwrap` started by faztudo.
  faztudo itself and agent CLIs that run without bubblewrap get no such
  permission, and programs run by bubblewrap are stacked under a profile that
  denies user namespaces and capabilities. The package never replaces a
  symlink or a file you edited at `/etc/apparmor.d/faztudo`; put local changes
  in `/etc/apparmor.d/local/faztudo`.
  System tools and a small set of `/etc` files are read-only. Toolchain roots
  in home `PATH` entries named `bin`, `shims` or `scripts`, the Go module cache and paths in
  `runs.sandbox_read_only` are read-only. Go, npm and XDG caches use a private
  writable directory for this run. The selected CLI's config and sign-in
  paths are read-only, with writable per-run session directories and copies
  of session index files. Codex gets a `CODEX_HOME` of its own under the run's
  state directory: `config.toml`, `AGENTS.md`, `packages/`, `plugins/`,
  `skills/` and `rules/` are read-only binds of your `~/.codex` (or
  `$CODEX_HOME`), `auth.json` is the one writable host file, and everything
  else (sqlite databases, `tmp`, sessions) is fresh. The installed package
  tree is also visible read-only at its original absolute path for Codex's
  code-mode helper. Your Codex history, sessions and databases are not visible
  in the sandbox. Inside bubblewrap,
  Codex's own nested sandbox and approval prompts are disabled; bubblewrap
  still limits its filesystem and network access. Kimi gets a private writable
  home over `~/.kimi-code`, with config and tools read-only and its credential
  and OAuth directories writable for token refresh. Agy has a private writable
  `~/.gemini/antigravity-cli` state tree with read-only settings and a
  writable OAuth token. OpenCode's database and logs use private XDG
  data, while its existing auth file is bound there for refresh. Other host
  credential exceptions are Claude's `.claude/.credentials.json`, Codex's
  `.codex/auth.json`, Grok's `.grok/auth.json`, Agy's
  `.gemini/antigravity-cli/antigravity-oauth-token` and OpenCode's
  `.local/share/opencode/auth.json`. The rest of home,
  including `~/.ssh`, is hidden. SSH agent, desktop and DBus sockets are not
  bound. Network stays on by default so CLIs can reach their APIs; a lane
  turns it off with `sandbox_network = false`. Such a run gets no MCP config
  because it cannot reach the local endpoint. Where a systemd user scope
  works, it sets `runs.sandbox_memory_max` (default `auto`: a quarter of RAM, 2G to 8G) and
  `runs.sandbox_tasks_max` (default 512). Without a scope the run is still
  sandboxed, just without those limits. Run `faztudo doctor` to check
  bubblewrap, unprivileged user namespaces and systemd user scope availability.
- **Honest limits.** The sandbox shares the host kernel, and the CLI still
  runs as your user. It can change its worktree and shared git objects;
  deleting or corrupting an existing object can damage the repository despite
  read-only refs. It can also change writable
  credential exceptions and session state, and access the network
  when allowed. Repository content and the channel test command remain
  untrusted, but execute inside the sandbox. Disabling host-side git hooks
  also means repository hooks do not protect merges from agent worktrees;
  review the diff before approving. Codex receives its per-run MCP bearer
  token through the process environment, not argv. It does not
  isolate the CLI from another process running as your user. In `auto` mode
  (an explicit opt-in), a missing or unusable sandbox falls back to an
  unsandboxed run with one channel notice, and the channel test command is
  then not run at all, because it would execute agent-written code as you.
  In `required` mode that run is refused. A lane's `sandbox` setting takes
  precedence over the global setting for write runs. A config file written
  before v0.1.0 that says `sandbox = "auto"` keeps it; change it to `"required"`.
- **v0.1.0 network and OAuth exception.** Write runs keep the network on by
  default, so the CLI can reach its provider and the faztudo MCP endpoint.
  Inside the sandbox these host credential files stay writable, because the
  CLI must refresh its login: Claude `.claude/.credentials.json`, Codex
  `auth.json` (in its per-run `CODEX_HOME`), Grok `.grok/auth.json`, Agy
  `.gemini/antigravity-cli/antigravity-oauth-token`, OpenCode
  `.local/share/opencode/auth.json`, and for Kimi the whole `credentials/` and
  `oauth/` directories under `~/.kimi-code`. A hostile run with network can
  read these tokens and send them out, or replace one so the next unsandboxed
  run uses another account. To close that, set `sandbox_network = false` on
  the lane (this also removes MCP for that lane); the CLI then cannot reach
  its API, so use it for offline tools or accept a broken refresh.
- **Channel access.** Channel lists, messages, threads, pins, search, the live
  stream and uploaded files are limited to channels the caller may read.
  Lane edits, channel create/edit, run cancel and retry, lane probes and
  uploads are human-only. Read runs without a repository start in an empty
  scratch directory, never the data directory, and channel summaries use the
  same stripped environment as runs. Run and approval lists are not yet
  filtered by channel membership.
  Read runs are unchanged. A sandboxed run ends if its parent exits; recovery
  records an interrupted run rather than resuming its process.
- **Which CLIs run in the sandbox.** Claude, Codex, Grok and Agy passed the
  live write-run fixture, including `go test` and `npm test`. Kimi started
  inside its private home and reached its provider, but its five-hour usage
  limit stopped the run before it could answer. OpenCode wrote its database
  and logs in private XDG data but timed out waiting for its selected provider;
  a short prompt also timed out outside bubblewrap. Its model-backed write run
  remains unverified. Recheck with `FAZTUDO_LIVE_SANDBOX=1 go test
  ./internal/runner -run TestLiveSandboxedCLIWriteRun -v`. The check at the
  start of every run only proves the CLI answers `--version` inside the mounts;
  a CLI that fails later fails that run without falling back to an unsandboxed
  one.
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


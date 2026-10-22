# 0006: Agent computers are persistent bubblewrap homes, one per agent

Status: proposed, 2026-10-22, revised the same day after security review

## Context

Every write run today builds a fresh bubblewrap sandbox (`internal/sandbox`,
`internal/runner/sandbox.go`): host `/usr` read-only, the worktree, the shared
git objects, the CLI's settings read-only, its OAuth file writable for
refresh, and a per-run state directory under `<run dir>/<run id>/sandbox`
holding the Go, npm and XDG caches, the private Codex, Kimi, Agy and OpenCode
homes, and per-run copies of the git admin files and the CLI session index
files (`copyGitAdminFile`). The Director's home is otherwise absent:
`sandbox.Build` never mounts it; `HOME` only names its path. The state
directory is discarded at run end, so an agent reinstalls its tools and
refills every cache each time, and nothing it started outlives the run.
Memory and task limits come from a transient systemd user scope; the `.deb`
ships an AppArmor profile that grants user namespaces to `/usr/bin/bwrap`
alone.

The roadmap (M4) promises a persistent sandbox per agent with its own home,
tools, caches, long-running processes, limits, a port range and a reset
button, with CLI logins staying on the Director's machine. Hosted agent
products are criticised for one machine shared by every agent with pooled
logins. This record decides how to build the promise without repeating that.
The security review of the first draft showed that a persistent home sits on
the next run's execution path; this revision answers it.

## Decision

- **Isolation tool: bubblewrap, as today, plus a systemd user slice.** A
  computer is a directory `<data>/computers/<id>/` with `home/` and
  `caches/`. A write run on that computer uses today's mount plan with
  additions in a fixed order: first `--bind <computer>/home <host home>`,
  then every read-only bind `sandbox.Build` makes today (CLI settings via
  `authPaths`, toolchain roots, the host module cache, `sandbox_read_only`),
  then the private CLI homes and the writable OAuth files. bubblewrap applies
  binds in argument order and later binds cover earlier ones, so a host-owned
  path always wins over a same-named file in the computer's home: a planted
  `~/.local/bin/git` sits under the host's read-only `~/.local/bin` when that
  directory is on the Director's `PATH`, and `~/.claude/settings.json` is
  always the host's. The run is refused if the computer's home contains
  `.ssh`, `.config/gh`, `.git-credentials` or `.netrc`: git, ssh and gh
  trust those names at the host path. Nothing new to install; the AppArmor
  profile still applies. Read runs do not use computers.
- **Persisted data is never on the implicit execution path.** The home keeps
  tool installs, notes, editor settings and whatever the agent writes, but no
  run reads configuration from it. For computer runs the runner pins
  `GIT_CONFIG_GLOBAL` to a per-run file holding only
  `core.hooksPath=/dev/null` (`/etc/gitconfig` is already the read-only host
  file), `GOENV=off`, `NPM_CONFIG_USERCONFIG` to an empty per-run file,
  `SHELL=/bin/sh` with `ENV` and `BASH_ENV` unset (`stripEnv` passes the host
  `SHELL` through today, and a CLI's shell tool sources that shell's rc
  files), `ZDOTDIR` to an empty per-run directory, and `PATH` to the read-only toolchain roots plus `/usr/local/bin`,
  `/usr/bin` and `/bin`. No directory of the home is on `PATH`: the agent
  runs its own installs by path, and the channel test command, which runs
  through `/bin/sh -c` in the same mounts, finds nothing the home planted.
  Login shell files in the home (`.profile`, `.bash_profile`, `.bashrc`,
  `.zshenv`, `.zprofile`, `.zshrc`, `.zlogin`) are covered by read-only
  empty files bound over them for every run, because a login `sh` reads
  `~/.profile` and `zsh` always reads `.zshenv`; either could undo the pins.
- **What persists.** The home and the caches. What does not: `/tmp` (tmpfs
  per run), CLI session state (per run, as today), the git admin and ref
  copies, the worktree. Worktrees stay outside and bind-mounted at their host
  path, where the host merge flow and the tamper checks in
  `internal/worktree` read them.
- **One run at a time.** A computer runs one write run at a time; a second
  write run for the persona waits in `queued` as it does behind a busy lane.
  Two writers in one home and one cache would replace files under each
  other, and reset needs a quiet computer. There is no live namespace to
  join in v1.
- **Caches.** `NPM_CONFIG_CACHE` and `XDG_CACHE_HOME` move from the run
  state directory to `<computer>/caches/`. `GOCACHE` stays per run: Go
  replaces action-cache entries, executables included, so a persistent build
  cache would let one run hand the next a binary it then executes. `XDG_DATA_HOME`,
  `XDG_STATE_HOME` and `XDG_CONFIG_HOME` stay per run: they hold CLI
  databases and configuration. `GOMODCACHE` stays the host's, read-only
  (`goModCache`); a persistent writable module cache would be a new way to
  poison a build.
- **Logins.** Unchanged: the CLI's settings are bound read-only and its OAuth
  file (for Kimi, its `credentials/` and `oauth/` directories) writable from
  the host at run start, and unbound at run end. The computer never holds a
  login at rest. New risk: a run can copy a bound credential into its
  persistent home for a later run to read. Mitigation in v1: at run start
  and at run end (a run killed before its end scan is caught by the next
  start) faztudo walks `home/` and `caches/` through `os.Root`, so a symlink never
  resolves outside the computer directory, deletes only regular files that
  hold a bound token value verbatim (checked with `Lstat`, not inferred from
  `os.Root`, which follows a symlink that stays inside), and posts a channel notice. It never
  touches a path outside the computer directory; a symlink to the host
  `.claude/.credentials.json` is skipped, not followed. Honest limit: encoded
  copies and planted code are not detected; the execution-path rules above
  are the guard against planted code.
- **Services and ports.** v1 has no background processes: whatever a run
  starts dies with it (`--die-with-parent`). Write runs keep the host network
  namespace, so a process can bind `0.0.0.0` and dial `127.0.0.1`, including
  faztudo, as today. Each computer gets a block of 20 ports from
  `computers.port_base` (default 7500), exported as `FAZTUDO_PORT_BASE` and
  `PORT`; in v1 it is a label: faztudo shows what the computer's processes
  listen on (`/proc/net/tcp` filtered by the slice's pids) and says when one
  bound `0.0.0.0`. Services that outlive a run arrive only after the
  network namespace exists (see the staged plan).
- **Limits and accounting.** All of a computer's runs go into one slice
  `faztudo-computer-<id>.slice` with `MemoryMax` (default
  `sandbox_memory_max`), `TasksMax` (default `sandbox_tasks_max`) and optional
  `CPUQuota`. Each run keeps its own scope inside the slice
  (`systemd-run --scope --slice=...`), so the scope report still reads
  `memory.peak` and `oom_kill` per run: cgroup v2 counts a kill in the
  victim's cgroup and its ancestors, so the run whose process died is the one
  that reports it. The report adds the slice name; the spike confirms the
  attribution. Disk has no unprivileged quota, so it is measured by a
  periodic walk that does not follow symlinks (soft limit
  `computers.disk_soft_max`); a full computer refuses new runs until reset or
  raised. The persona entry and the desk screen show state, memory, disk and
  ports; `GET /api/v1/computers` and `POST .../reset` are human-only.
- **Reset.** Stops the slice (`systemctl --user stop`), refuses while a run on
  the computer is recorded as running or the slice still has pids, then
  deletes `home/` and `caches/`. The id and port block stay. Reset cannot undo
  an OAuth file a run refreshed or replaced (writable bind, a risk `SECURITY.md`
  already names), objects written into the shared git `objects/`, or anything
  sent over the network; the confirmation says so.
- **Sharing.** v1 is one computer per persona, id = persona handle, and
  nothing else. A shared computer is one trust domain: one persona's planted
  file would run while another persona's OAuth file is mounted. Team
  computers (`[[computer]]` with `members`) wait for a later revision, after
  the execution-path rules have shipped, and will be an explicit opt-in
  listed on the Organization page.
- **Security.** Inside a computer an agent sees host `/usr` read-only, its own
  home, its worktree and the git objects, the network the lane allows,
  nothing else of the Director's home, no SSH agent, display or session bus.
  It reaches faztudo only through the per-run MCP config. The run bearer dies
  with the run (`internal/mcp/tokens.go`), approvals are resolved by humans
  only (`resolve` in `internal/api/api.go`; MCP has no such tool), and merge,
  keep and discard stay host-side with `core.hooksPath=/dev/null`
  (`internal/worktree/worktree.go`). Accepted residual: a later run of the
  same persona trusts what an earlier run left in that home, as it already
  trusts the repository it checks out; a script it chooses to run gets that
  run's token for `post_message` and `delegate` in that run's channel. A
  stuck or full computer stops only its own persona's write runs.

## Security review (2026-10-22)

1. Accepted: execution-path rules above. Correction: `/etc/gitconfig` is
   already a read-only host bind (`sandbox.go`), so `GIT_CONFIG_SYSTEM` needs
   no pin; `SHELL` and the shell rc files were missing from the finding and
   are pinned too.
2. Accepted: bind order fixed, refused names listed.
3. Accepted: `os.Root` walk, regular files only, `caches/` included.
4. Accepted: no team computers in v1.
5. Accepted: slice stopped first, pid check, list of what reset cannot undo.
6. Accepted: network namespace moved ahead of services.
7. Accepted: variables named, `GOMODCACHE` read-only, one write run per
   computer.
Nits: the never-copied line now says credential files; session index and
git admin files are per-run copies. Kimi directories named. `MemoryMax`
attribution argued above (per-run scope inside the slice), to be confirmed
by the spike.

## Alternatives considered

- **systemd-nspawn.** Needs root to start containers; out on a desktop
  without it.
- **Rootless podman.** Real attach, a network namespace with port forwarding
  and cgroups for free, but a `subuid` entry (root, once), its own images
  instead of the host's `/usr` and installed CLIs, and its own AppArmor answer
  on Ubuntu 24.04. A candidate backend for v3.
- **incus or LXD.** Root to install, a daemon, full OS containers: more than
  a persistent home needs.
- **A QEMU VM.** The strongest wall, but a disk image, boot time, slow file
  sharing with worktrees, and logins would have to be copied in, which
  record 0003 forbids. Left to M7.

## Review point

bubblewrap stays unless the service lifecycle cannot be made reliable
without joining a live namespace. The spike before v3 measures whether
`nsenter` into a bwrap user namespace owned by the same uid works under the
AppArmor profile, and whether the per-run `oom_kill` attribution holds under a
slice limit. If attach fails, services run as separate bwrap instances that
share the home.

## Staged plan

1. v1: `[computers] enabled`, one computer per persona, persistent home and
   caches with the execution-path rules and bind order above, one write run
   at a time, the slice with memory, tasks and CPU limits, disk measured, the
   credential copy scan, reset from the API and the persona entry, the desk
   screen. No services, no team computers.
2. v2: a network namespace per computer (pasta) that forwards only the port
   block to `127.0.0.1`, which also makes `sandbox_network = false` cheaper;
   listening ports shown and reachable.
3. v3: Director-declared services under `services/` with idle stop
   (`computers.idle_stop_minutes`, default 30), stopped on idle or reset;
   agent-requested services through an MCP tool behind an approval; podman as
   an optional backend; team computers revisited.

Out of scope: cloud computers and computers on another machine (M7, optional,
never the default), desktop computers with a screen (M7), and one machine for
every agent with pooled logins (never).

## Consequences

- Tool installs and caches survive between runs, so repeat runs start faster
  and the agent keeps an environment it can inspect.
- Installed tools are not on `PATH`; an agent calls them by path or the
  Director adds a read-only toolchain root. Slower for the agent, but a
  planted binary is never found by name.
- A persistent home is a new place for a credential copy to live; the scan,
  the per-persona rule and reset limit it. Planted code is stopped by the
  execution-path rules, not by the scan.
- One write run per computer serialises a busy persona.
- Disk use grows until reset; the soft limit makes that visible.

## Open

- Whether `nsenter` into a bwrap namespace works under the Ubuntu 24.04
  profile (needed for attach; not for v1).
- Whether per-run `oom_kill` attribution holds under a slice limit.
- Whether to offer `path_in_home` as an explicit per-computer opt-in that puts
  `~/.local/bin` back on `PATH`, with the risk stated.
- The scan misses encoded copies; the better answer is per-run short-lived
  tokens, which depends on each CLI.
- Whether CPU limits should default on; a quota slows builds on a laptop.

# 0006: Agent computers are persistent bubblewrap homes, one per agent

Status: proposed, 2026-10-22

## Context

Every write run today builds a fresh bubblewrap sandbox (`internal/sandbox`,
`internal/runner/sandbox.go`): host `/usr` read-only, a worktree, the shared
git objects, the CLI's settings read-only, its OAuth file writable for
refresh, and a per-run state directory under `<run dir>/<run id>/sandbox`
holding Go, npm and XDG caches, the private Codex, Kimi, Agy and OpenCode
homes, and the run's git admin copies. When the run ends that directory is
discarded, so an agent reinstalls its tools and refills every cache each
time, and nothing it started can outlive the run. Memory and task limits come
from a transient systemd user scope; the `.deb` ships an AppArmor profile
that grants user namespaces to `/usr/bin/bwrap` alone.

The roadmap (M4) promises a persistent sandbox per agent or team with its own
home, tools, caches, long-running processes, limits, a port range and a reset
button, with CLI logins staying on the Director's machine and the computer
drawn as the screen at the agent's desk. Hosted agent products are criticised
for one machine shared by every agent with pooled logins: one stuck machine
stops everyone, and agents are not a security boundary from each other. This
record decides how to build the promise without repeating that.

## Decision

- **Isolation tool: bubblewrap, as today, plus a systemd user slice.** A
  computer is a directory `<data>/computers/<id>/` with `home/`, `caches/`
  and `services/`. A write run on that computer uses the existing mount plan
  with two changes: `home/` is bind-mounted over the Director's home path
  (the CLIs look for `~/.claude`, `~/.codex` there), and the caches move
  from the run's state directory to `caches/`. Nothing new to install: a
  machine that can run a write run can run a computer, and the AppArmor
  profile still applies. Read runs do not use computers.
- **What persists.** The home (tool installs under `~/.local`, `~/go/bin`,
  shell and editor settings, notes), the caches, and declared services. What
  does not: `/tmp` (tmpfs per run), the CLI session state (stays per run as
  today, so concurrent runs do not fight over session locks), the git admin
  and ref copies (per run), the worktree. Worktrees stay outside, bind-mounted
  at their host path as today: the host merge flow and the tamper checks in
  `internal/worktree` read them there, and a worktree inside a persistent
  home would survive its run. Reset stops services and deletes `home/` and
  `caches/`; the id and port block stay.
- **Attaching.** A run attaches by starting bubblewrap with the computer's
  directories; there is no live namespace to join in v1. Several runs may use
  one computer at once because they have separate worktrees and separate
  session state; the shared caches are built for concurrent use.
- **Logins.** Unchanged: the CLI's settings are bound read-only and its OAuth
  file writable from the host at run start, and unbound at run end. The
  computer never holds a login at rest. New risk: a run can copy a bound
  credential into its persistent home, where a later run on the same computer
  reads it. Mitigation in v1: at run end faztudo searches the computer's home
  for the exact token values it bound, deletes any file holding one, and
  posts a channel notice. This catches verbatim copies only (open: encoded
  copies). Services get no credential binds at all; a service is not a CLI.
- **Services and ports.** v1 has no background processes: whatever a run
  starts dies with it (`--die-with-parent`), as today. v2 adds services the
  Director declares in the computer's settings (command, working directory,
  idle stop after `computers.idle_stop_minutes`, default 30), started on the
  first run that needs the computer and on demand from the UI, stopped on
  idle or reset. Each computer gets a block of 20 ports from
  `computers.port_base` (default 7500), exported as `FAZTUDO_PORT_BASE` and
  `PORT`. Write runs keep the host network namespace, so in v1 and v2 the
  block is a convention: faztudo shows what the computer's processes listen
  on (from `/proc/net/tcp` filtered by the slice's pids) and the Director
  opens `http://127.0.0.1:<port>`. A process may still bind `0.0.0.0`; the UI
  says so when it does. Enforced ranges need a network namespace (v3).
- **Limits and accounting.** All of a computer's runs and services go into
  one slice `faztudo-computer-<id>.slice` with `MemoryMax` (default the
  existing `sandbox_memory_max`), `TasksMax` (default `sandbox_tasks_max`)
  and optional `CPUQuota`; the existing scope report keeps reading
  `memory.peak` and `oom_kill` per run. Disk has no unprivileged quota, so it
  is measured (a periodic `du`, soft limit `computers.disk_soft_max`) and a
  full computer refuses new runs until reset or raised. The Organization
  page's persona entry and the desk screen show state (off, idle, running,
  stopped on memory, full), memory now and peak, disk used, services and
  ports, with `GET /api/v1/computers` and `POST .../reset` behind human-only
  auth. The Lanes page stays about lanes.
- **Sharing.** Default one computer per persona, id = persona handle. A team
  computer is an explicit `[[computer]]` in `lanes.toml` with a `members`
  list; personas name it with `computer = "<id>"`. faztudo refuses a config
  where every persona shares one computer, and the Organization page lists
  who shares each.
- **Security.** Inside a computer an agent sees: host `/usr` read-only, its
  own home, its worktree and the git objects, the network the lane allows,
  nothing else of the Director's home, no SSH agent, display or session bus.
  It reaches faztudo only through the MCP config a run gets today. A computer
  has no push path: merge, keep and discard stay host-side behind approvals,
  and a service runs without git credentials. A stuck or full computer stops
  only its own persona's write runs; the lane and the other personas go on.

## Alternatives considered

- **systemd-nspawn.** Needs root to start containers; out on a desktop
  without it.
- **Rootless podman.** Gives real attach (`podman exec`), a network namespace
  with port forwarding and cgroups for free, but needs a `subuid` entry
  (root, once), its own images instead of the host's `/usr` and the CLIs the
  Director installed, and its own AppArmor answer on Ubuntu 24.04. A
  candidate backend for v3 when an agent needs a different distribution.
- **incus or LXD.** Root to install, a daemon, full OS containers: more than
  a persistent home needs.
- **A QEMU VM.** The strongest wall, but a disk image, boot time, slow file
  sharing with worktrees, and the CLIs' logins would have to be copied in,
  which point 3 forbids. Left to M7 for agents that need a screen.

## Review point

bubblewrap stays unless the v2 service lifecycle cannot be made reliable
without joining a live namespace. The spike before v2 measures whether
`nsenter` into a bwrap user namespace owned by the same uid works under the
AppArmor profile; if not, v2 services run as separate bwrap instances that
share the home, and attach stays off the table.

## Staged plan

1. v1: `[computers] enabled`, one computer per persona, persistent home and
   caches, the slice with memory, tasks and CPU limits, disk measured, the
   credential copy scan, reset from the API and the persona entry, the desk
   screen showing state. No services.
2. v2: Director-declared services with idle stop, the port block, listening
   ports shown and reachable at `127.0.0.1`.
3. v3: agent-requested services through an MCP tool behind an approval; a
   network namespace (pasta) that forwards only the block to `127.0.0.1` and
   makes `sandbox_network = false` cheaper per computer; podman as an
   optional backend.

Out of scope: cloud computers and computers on another machine (M7, optional,
never the default), desktop computers with a screen (M7), and one machine
for every agent with pooled logins (never).

## Consequences

- Tool installs and caches survive between runs, so repeat runs start faster
  and the agent keeps a working environment it can inspect.
- A persistent home is a new place for a credential copy or a planted script
  to live; the scan and the per-persona default limit the blast radius, and
  reset is one click.
- Disk use grows until reset; the soft limit makes that visible.
- Shared caches between concurrent runs trade isolation for speed; a cache
  corruption affects one persona and clears on reset.

## Open

- Whether `nsenter` into a bwrap namespace works under the Ubuntu 24.04
  profile (needed for attach; not needed for v1).
- The credential scan misses encoded copies; a better answer may be
  per-run short-lived tokens, which depends on each CLI.
- Install cost of podman on a stock 24.04 desktop and its AppArmor status
  were not measured.
- Whether CPU limits should default on; a quota slows builds for everyone on
  a laptop.

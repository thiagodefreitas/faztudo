# Changelog

All notable changes are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.4] - 2026-10-19

### Added

- The desktop app for Linux: faztudo in its own window with a tray icon,
  as a `.deb` that needs the faztudo package and as an AppImage that carries
  faztudo, for amd64 and arm64. Closing hides to the tray, Quit asks whether
  to leave faztudo running, Start at login, desktop notifications, and a
  daily update notice that never updates by itself.
- `faztudo stop` cancels the agent runs in progress and stops the systemd
  user unit.
- Signal bridge, step 2: `faztudo bridge signal` translates between the local
  bridge protocol and a separate user-installed signal-cli process. A link
  command shows a terminal QR code, and doctor checks for the linked account.
  Signal approval replies remain for step 3.
- `faztudo doctor` reports whether the AppArmor profile is installed and
  whether this faztudo is the packaged one, on systems that restrict user
  namespaces.

### Fixed

- A lane that hit its quota keeps its reset time across a daemon restart
  instead of staying exhausted until changed by hand.

## [0.1.3] - 2026-10-18

### Added

- Office zoom: scroll or pinch to zoom the 2D office, drag to pan, click a
  department, pod or the Director area to zoom to it, and use the corner
  control or the keyboard to zoom, fit all or jump to an area. In 3D,
  "Jump to" moves the camera to that area.
- `faztudo connect --json` prints the daemon address and a one-time sign-in
  code, never the token, for programs such as the desktop app.
- The demo data shows a fuller organization, with Engineering, Quality and
  Product departments.

### Fixed

- The web app starts the live event stream at the current head instead of
  replaying the whole event log, so a large workspace opens quickly.

## [0.1.2] - 2026-10-18

### Added

- Compare mode: mention a write persona with `x2` to run one request on two
  lanes, then merge one candidate, discard both or combine them. Only people
  can start a compare.
- A worked organization example (`docs/examples/organization.toml`) and a
  guide to start a new project from an existing one.
- Signal bridge, step 1: the bridge protocol, a shared path for posting and
  resolving approvals, and the bridge supervisor. Off by default; the Signal
  program itself comes next.

### Fixed

- Ubuntu 24.04: the AppArmor profile now gives user namespaces to
  bubblewrap only; everything else faztudo starts, and everything
  bubblewrap runs, gets none. The package no longer replaces a profile you
  edited.
- A run that hits its timeout ends instead of being retried.
- A run killed for memory says so and records its peak memory; lane health
  shows the CLI's own quota line instead of agent output.
- Lane probes for CLIs without a probe say so instead of "resource
  conflict".
- The approvals inbox no longer shows resolved approvals as waiting, and
  hidden lanes stay hidden.
- The compare card reads only its channel's events (new index, migration
  008) instead of the whole event log.

## [0.1.1] - 2026-10-18

### Fixed

- Ubuntu 24.04: the `.deb` installs an AppArmor profile so the bubblewrap
  sandbox can create its user namespace; without it every write run refused
  to start. Only installed where the kernel restricts user namespaces, and
  removed with the package. The tarball carries the same profile.
- Sandbox memory: `sandbox_memory_max` defaults to `auto` (a quarter of RAM,
  2G to 8G), a write run waits for free memory instead of being killed, and
  the web tests use at most four workers.
- A `/lane` override a persona cannot use says which lanes it can.
- Long agent answers keep their beginning, where the summary is, instead of
  only their last 8 KB; the full text stays in the run output.

## [0.1.0] - 2026-10-18

First usable alpha.

### Chat

- Channels, threads and direct messages with a live event stream, an inbox
  home, a command palette and search over message bodies.
- Pins, file attachments (images inline, other files as cards) and browser
  notifications for mentions, approvals and failed runs.
- Run cards that start with one plain sentence, folded details, long answers
  folded after about twelve lines, and a run timeline with tokens and an
  estimated cost when the CLI logs them.
- Project homes, a sidebar grouped by project and a "Needs you" count.
- A catch-up card when you open a busy channel, a New divider with a jump
  to the first unread message, day dividers, grouped messages, filters for
  mentions, runs, decisions and files, and a list of the channel's threads.

### Agents and lanes

- Runs through Claude Code, Codex, Grok, Kimi, Antigravity and OpenCode, read
  only or in a git worktree, with verification, approvals and merge.
- A faztudo MCP server for agents: read context, post, ask a human, request
  approval, delegate.
- Lanes with usage read from the CLIs' own logs, health, announced switching,
  history, cost estimates, alerts and rolling channel summaries.

### Tasks and approvals

- Tasks: a directive for one agent with scope, checks and acceptance,
  started from the composer or `/task`, tracked on a board per project.
- An approvals inbox with every pending decision across channels, diff
  previews, an editable commit message and one-key answers; refused merges
  say why.
- Merge replays a run's commit when the branch moved, names conflicting
  files, and refuses when the repository switched branches.

### Organization

- A Director, departments, specialists and cross-functional projects, with
  project-scoped routing.
- New project and team channel dialogs, a members panel, project settings,
  archiving, and a daily digest on each project home.
- A Chief of Staff that delegates work, routines on a schedule or on new
  messages, and `faztudo init --template solo|team|empty`.

### Office

- A 2D office where every agent has a desk, a character and a live state,
  and a lazy loaded 3D office with the same characters, keyboard control and
  a side panel per desk.

### Security

- Local API calls need a private token, also on loopback.
- Write runs are sandboxed with bubblewrap and fail closed by default
  (`sandbox = "required"`): a read-only shared `.git` except objects,
  per-run state, a stripped environment, and the test command runs inside
  the sandbox. Host git ignores repository hooks, filters, external diff
  programs and merge drivers. `sandbox = "auto"` is an explicit opt-in.
- Read runs and channel summaries start in an empty scratch folder with the
  stripped environment, never in the data directory.
- Private channels, their messages, events and files are visible only to
  members, and every change to channels, lanes, runs, approvals, tasks and
  the organization is human-only.
- Known limits for 0.1.0: write runs keep network access by default, CLI
  OAuth refresh files stay writable inside the sandbox, and read runs are
  not sandboxed. See SECURITY.md.

### Phone and LAN

- LAN mode with HTTPS from a local certificate authority, password login and
  phone pairing by QR code, with revocable devices.
- An installable phone app (PWA) that caches only the app shell.

### Packaging

- Single binaries for Linux amd64 and arm64 with the web app embedded, a
  tarball, a `.deb` with a systemd user unit, and checksums.

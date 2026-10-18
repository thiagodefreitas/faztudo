# Changelog

All notable changes are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [0.1.0] - Unreleased

First usable alpha. Not tagged yet; the date is set when it ships.

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

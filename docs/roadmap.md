# Roadmap

Milestones are tracked on GitHub. Each one ends with something you can use,
not just something that compiles. Order can change as we learn; the reasons
for a change are written in the milestone's tracking issue.

## M0 Foundation

License, contribution rules, security policy, design documents, decision
records, CI with secret scanning and authorship checks, documentation site,
issue templates and the issue backlog for M1.

## M1 First dogfood

The smallest version we can use every day to build faztudo itself.

- Daemon with the SQLite event log, HTTP API and WebSocket stream.
- `faztudo init`, `serve`, `doctor`, `agents detect`, `lanes`.
- Web chat with channels, mentions, markdown and code, streaming agent
  output, run cards with the verification result, diff view and approval
  cards.
- Adapters for Claude Code and Codex.
- Runs in git worktrees, with capacity limits, timeouts, failure classes,
  verification, and recovery when the daemon restarts mid-run.
- Lanes: health with source and age for every number, manual lane choice,
  and an announced switch when a lane fails with a quota error.

Exit: in `#faztudo-dev`, `@codex` implements an issue in a worktree,
`@claude` reviews it, the human approves, and the diff and verification
result are visible in the chat.

## M1b Team chat and Lanes

- Threads, direct messages, command palette, keyboard navigation everywhere.
- Adapters for Grok, Kimi, Antigravity and OpenCode.
- Lanes dashboard; switching on usage thresholds once the measurements are
  calibrated against real exhaustion events.
- faztudo MCP server so agents can post, ask and request approvals.
- Optional Linux sandbox (bubblewrap) for write runs.
- Organization, part one: departments with a lead, projects that group
  channels and a repository, assigning departments and specialists to
  projects, `@department` mentions. See [organization](organization.md).

## M2 Usable alpha (first release)

- LAN mode: TLS, login, pairing a phone by QR code, installable web app.
- Search, pinned messages, files, unread state, notifications, presence.
- Lanes history, cost estimates and alerts. Channel summaries so long
  conversations stay within model limits.
- A sandbox for write runs (bubblewrap, no root): the worktree is writable,
  the rest of your home is hidden, the agent CLI sees only the login files it
  needs, memory and process limits where systemd allows them.
- Security review, clean install test, complete docs, first release packages
  (tarball, deb, AppImage).
- Organization, part two: the Chief of Staff routes unaddressed requests,
  leads split team requests across their specialists (one level of
  delegation, every handoff visible, run budgets), routines on a schedule or
  trigger with a daily debrief, starting organization templates.
- At least two weeks of building faztudo inside faztudo, with what broke
  written down, before the first release. (The repository itself went
  public earlier, on 2026-10-18, so development happens in the open.)

## M3 Signal

A Signal bridge through `signal-cli` as a linked device. Map a Signal group
or your own note-to-self chat to a channel, with an allowlist of numbers.

## M4 2D office

An office drawn in the browser. Each member has a desk and acts out what it
is doing: typing, waiting with a raised hand for an approval, idle, failing.
Click anyone to see their current run. Approvals can be answered in the
scene.

Agent computers: a persistent sandbox for one agent or shared by a team,
with its own home, tools, caches and long-running processes, resource
limits, a port range and a reset button. Logins for the agent CLIs stay on
your machine. Each computer shows up in the office as the screen at its
desk.

## M5 Discord and extensions

A Discord bridge. A documented bridge protocol so others can write bridges.
Custom agent adapters described in a config file, for any command line agent.

## M6 3D office and desktop app

A 3D version of the office from the same event stream. A desktop app for
Linux with a tray icon and notifications.

## M7 Teams and federation

Several people in one workspace with roles and private channels. Bridges for
Hermes and OpenClaw. WhatsApp through the official Cloud API. An endpoint for
connecting with agent teams on other machines. Agent computers on another
machine in your network, and desktop computers for agents that need a
screen. Cloud computers stay optional.

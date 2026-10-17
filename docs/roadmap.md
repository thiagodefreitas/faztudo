# Roadmap

Milestones are tracked on GitHub. Each one ends with something you can use,
not just something that compiles. Order can change as we learn; the reasons
for a change are written in the milestone's tracking issue.

## M0 Foundation

License, contribution rules, security policy, design documents, decision
records, CI with secret scanning and authorship checks, documentation site,
issue templates and the issue backlog for M1.

## M1 Chat and agents

The first version we use every day to build faztudo itself.

- Daemon with the SQLite event log, HTTP API and WebSocket stream.
- `faztudo init`, `serve`, `doctor`, `agents detect`, `lanes`.
- Web chat: channels, threads, direct messages with agents, mentions,
  streaming agent output, markdown and code, diff view, approval cards,
  command palette, keyboard navigation, light and dark themes.
- Adapters for Claude Code and Codex, then Grok, Kimi, Antigravity and
  OpenCode.
- Runs in git worktrees, with capacity limits, timeouts, failure classes and
  verification.
- Lanes: per-agent usage and quota, personas with fallback chains, manual and
  automatic switching that is always announced.
- faztudo MCP server so agents can post, ask and request approvals.

## M2 Usable alpha (the repository becomes public here)

- LAN mode: TLS, login, pairing a phone by QR code, installable web app.
- Search, pinned messages, files, unread state, notifications, presence.
- Lanes history, cost estimates and alerts. Channel summaries so long
  conversations stay within model limits.
- Security review, clean install test, complete docs, first release packages
  (tarball, deb, AppImage).

## M3 Signal

A Signal bridge through `signal-cli` as a linked device. Map a Signal group
or your own note-to-self chat to a channel, with an allowlist of numbers.

## M4 2D office

An isometric office drawn in the browser. Each member has a desk and acts
out what it is doing: typing, waiting with a raised hand for an approval,
idle, failing. Click anyone to see their current run. Approvals can be
answered in the scene.

## M5 Discord and extensions

A Discord bridge. A documented bridge protocol so others can write bridges.
Custom agent adapters described in a config file, for any command line agent.

## M6 3D office and desktop app

A 3D version of the office from the same event stream. A desktop app for
Linux with a tray icon and notifications.

## M7 Teams and federation

Several people in one workspace with roles and private channels. Bridges for
Hermes and OpenClaw. WhatsApp through the official Cloud API. An endpoint for
connecting with agent teams on other machines.

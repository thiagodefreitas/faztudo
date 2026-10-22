# Roadmap

Milestones are tracked on GitHub. Each one ends with something you can use,
not just something that compiles. Order can change as we learn; the reasons
for a change are written in the milestone's tracking issue.

## Where things stand

As of 2026-10-20, release 0.1.7:

| milestone | state |
| :--- | :--- |
| M0 Foundation | done |
| M1 First dogfood, M1b Team chat and Lanes | done; faztudo is built inside faztudo |
| M2 Usable alpha | done; released as 0.1.0, then 0.1.1 to 0.1.7 |
| M3 Signal | in progress: the bridge protocol and daemon side (0.1.2) and the signal-cli bridge with linking (0.1.4); approval replies and alerts are next |
| M4 2D office | the office is done, with zoom; agent computers are not started |
| M5 Discord and extensions | the bridge protocol is documented; Discord and custom adapters are not started |
| M6 3D office and desktop app | a first 3D office ships; the Linux desktop app ships in 0.1.4 as a `.deb` and an AppImage (ADR-0005) |
| M7 Teams and federation | not started |

Also shipped along the way: tasks with a board, an approvals inbox, project
settings and digests, compare mode (one request on two lanes), and a
fail-closed sandbox that works on Ubuntu 24.04.

## Daily use

A track that runs next to the milestones: the things that make faztudo worth
opening every morning. Most build on parts that already exist. Listed in the
order we build them; each has an issue in the "Daily use" milestone.

| # | item | builds on | state |
| :--- | :--- | :--- | :--- |
| 1 | Lessons: tell an agent "remember this" on an answer; the lesson joins every later run of that persona, shows in the run's Context tab, and can be edited or deleted | prompt sections, Context tab | built |
| 2 | Repeat this: turn a finished run into a scheduled routine from its card | routines | built |
| 3 | Today: a brief at the top of the inbox with what needs you, what finished or failed since your last visit, what runs now and which lanes are short | inbox, runs, lanes | built |
| 4 | Approval rules: Allow once, Always here or Never on a card, and rules per channel or persona (for example, merge docs-only changes that passed verification). Off by default; a rule never pushes | approvals | built |
| 5 | Cost per run on All work and the Lanes page | usage readers | built |
| 6 | Untrusted content marked in the prompt: every transcript message names its author as human or agent and cannot forge another speaker, and GitHub data is labelled as data | prompt sections, bridges | built |
| 7 | Dictation in the message box, with the browser's speech recognition first and a local model later | composer | built |
| 8 | Drafts before sending: anything an agent sends through a bridge waits as an approval card | bridges, approvals | in progress |
| 9 | Routine triggers for a failing CI run and a new issue or pull request | routines | built |
| 10 | A read-only scout: a routine that reads the repository, CI and issues and files suggestions in the inbox; accepting one makes a task | routines, triggers, tasks | in progress |
| 11 | Agent computers (see M4 and [ADR 0006](adr/0006-agent-computers.md)): a persistent sandbox per agent, logins stay on your machine | sandbox, worktrees | in progress |

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
  (tarball and deb; an AppImage comes with the desktop app).
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

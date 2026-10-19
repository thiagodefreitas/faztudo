<p align="center">
  <img src="assets/brand/logo.svg" alt="faztudo" height="40">
</p>

# faztudo

Your agents and you, in one room.

faztudo is a small, MIT-licensed program you run on your own Linux machine.
It gives you a chat workspace, with channels, threads and direct messages,
where you and the agent CLIs you already use (Claude Code, Codex, Grok, Kimi,
Antigravity, OpenCode) work together. Mention `@codex` in a channel and Codex
works in its own git worktree, streams what it does, and waits for your
approval before anything is merged.

The name is Portuguese for "does everything". It does not, yet.

## What's in 0.1.0

0.1.0 is the first release you can install. It is an alpha: it works, and
formats may still change. This is what you get:

- Chat with channels, threads, direct messages, search, pins and files, plus
  a catch-up card and filters for busy channels.
- Runs on Claude Code, Codex, Grok, Kimi, Antigravity and OpenCode, with write
  runs in their own git worktree and a human decision before any merge.
- Tasks with a board, and an approvals inbox for every pending decision.
- Projects with settings, archiving and a daily digest, and team channels.
- Write runs sandboxed with bubblewrap, and refused when the sandbox cannot
  start.
- A 2D and a 3D office, and a phone app over your own network.

The full list is in the [changelog](CHANGELOG.md).

<p align="center">
  <img src="docs/images/chat.png" alt="A faztudo channel opened after time away: filter chips, a New divider, a catch-up card saying two new messages from Coder with Mark read, and a question with lettered answers" width="860">
</p>
<p align="center">
  <a href="https://thiagodefreitas.github.io/faztudo/#the-office"><img src="docs/images/office-3d.png" alt="The 3D office: each agent is a character at its desk, built from its avatar, with a raised-hand card where an approval waits, a task board and a lane strip" width="620"></a>
  <img src="docs/images/chat-phone.png" alt="A channel on a phone, with run cards and quick actions" width="200">
</p>
<p align="center">
  <a href="https://thiagodefreitas.github.io/faztudo/#the-office">Watch the 30 second tour</a> --
  <a href="docs/images/compare.png">compare mode</a> --
  <a href="docs/images/organization.png">organization</a> --
  <a href="docs/images/tasks-board.png">task board</a> --
  <a href="docs/images/approvals.png">approvals inbox</a> --
  <a href="docs/images/project-home.png">project home</a> --
  <a href="docs/images/office-2d.png">2D office</a> --
  <a href="docs/images/inbox-phone.png">phone inbox</a>
</p>

> **Status: alpha, version 0.1.4.** The chat, runs, approvals, tasks,
> projects, Lanes dashboard, Office and LAN mode for phones work today, and
> faztudo is built inside itself. Expect rough edges and changing formats.
> Issues and ideas are welcome. See the [roadmap](docs/roadmap.md).

## Why it is different

- **The agents you already have.** faztudo runs each agent through its own
  command line tool and its own sign-in. No extra API keys, no new accounts.
- **Chat first.** Channels, threads, direct messages, mentions, a command
  palette and keyboard navigation. Everything else is a view on the chat.
- **Humans and agents in the same channels.** Agents are members with a
  handle you mention. Unaddressed messages can go to a channel's default
  agent.
- **Original avatars and an Office view.** Each agent CLI has its own small
  character in its color (no vendor logos), personas add a role badge, and a
  ring shows when an agent is working, waiting for you or failed. The Office
  page puts every member at a desk so you can see who is busy, check lane
  health or jump to a run.
- **Lanes and a quota dashboard.** A lane is one agent CLI with one model
  route. The Lanes page shows usage where the CLI exposes it, where the
  number came from and how old it is. When a lane is exhausted, work moves
  to the next lane in the persona's list and the channel says so.
- **Write runs stay in a worktree.** A run that may change files works in its
  own git worktree. When it finishes you see the diff and choose Merge, Keep
  or Discard. An agent cannot approve for you.
- **Local, with phone access.** One binary, one SQLite file, no cloud
  service, no telemetry. Optional LAN mode serves the web app over HTTPS to
  your phone, with a password and QR code pairing.

## Features

- **Catch-up and filters.** Opening a busy channel shows what happened since
  you left, a New divider, and filters for mentions, runs, decisions and files.
- **Tasks and the board.** Give an agent a directive with scope, checks and
  acceptance, and follow it from Todo to Done. See
  [tasks and approvals](docs/tasks-and-approvals.md).
- **Approvals inbox.** Every pending decision across channels in one list,
  with the diff, an editable commit message and one-key answers.
- **Projects.** Settings, archiving and a digest of what merged, failed and
  waits for you. See [projects](docs/projects.md).
- **Team channels.** Channels with several agents, where only the assigned
  ones run.
- **Fail-closed sandbox.** Write runs use bubblewrap and do not start without
  it, unless you choose `sandbox = "auto"`.
- **2D and 3D office.** Every agent at a desk, acting out what it is doing.
- **Phone app.** An installable web app over HTTPS on your LAN.

## What works today, and what is planned

| area | state |
| :--- | :--- |
| Channels, threads, direct messages, command palette, grouped messages, markdown with copyable code | works |
| Catch-up card, unread and day dividers, filters, thread list, search, pins, files, notifications | works |
| Adapters for Claude Code, Codex, Grok, Kimi, Antigravity, OpenCode | works; OpenCode is experimental |
| Original agent avatars with role badges and live state rings | works |
| Worktree write runs, diff view, approvals inbox, commit messages, merge replay | works |
| Tasks with directives and a board | works |
| Write-run sandbox (bubblewrap, no root), fail closed by default | works |
| Lanes dashboard, health from fresh usage, automatic lane switching, per-run usage | works |
| faztudo MCP server for agents (post, ask, request approval, delegate) | works |
| Director, departments, projects with settings and digest, Chief of Staff, routines | works |
| LAN mode: HTTPS, password, phone pairing, installable phone app | works; had an independent security review |
| 2D office and a first 3D office with the same characters | works |
| Packages: tarball and .deb with a systemd user unit, on GitHub releases | works |
| Signal bridge | planned (M3) |
| Agent computers (persistent sandboxes) | planned (M4) |
| Discord bridge, custom adapters | planned (M5) |
| Full 3D office, desktop app | planned (M6) |
| Multi-user teams, remote and desktop agent computers | planned (M7) |

## Quick start

You need Linux, git, bubblewrap and at least one signed-in agent CLI.

Download the `.deb` or the `.tar.gz` for your machine from the
[releases page](https://github.com/thiagodefreitas/faztudo/releases), together
with `checksums.txt`, then check and install:

```bash
sha256sum --check --ignore-missing checksums.txt
sudo apt install ./faztudo_X.Y.Z_linux_amd64.deb    # or unpack the tarball
faztudo init      # writes ~/.config/faztudo and finds your agent CLIs
faztudo doctor    # checks git, bubblewrap, each agent CLI and the port
faztudo serve     # serves http://127.0.0.1:7457 and opens the browser
```

Then create a channel, point it at a local git repository and type
`@codex what does this repository do?`. The
[getting started guide](docs/getting-started.md) walks through it, including
building from source (Go 1.25, Node.js 22, `make build`) and LAN mode for your
phone.

## How it works

```
  browser / phone ---HTTP(S) + WebSocket---> faztudo daemon (Go)
  agents calling back over MCP -------------> event log (SQLite)
                                              router -> runner -> agent CLIs
                                              (one git worktree per write run)
```

Everything that happens is an event in an append-only log. The chat and the
Lanes dashboard are views on that log. More in
[docs/architecture.md](docs/architecture.md).

## Credentials

faztudo never asks for your agent passwords. Each agent CLI keeps using its
own sign-in. The few secrets faztudo does hold live in your system keyring or
in a file only you can read under `~/.config/faztudo`. They are never written
to the database, the logs or this repository. See [SECURITY.md](SECURITY.md).

## Documentation

- [Documentation site](https://thiagodefreitas.github.io/faztudo/)
- [Wiki pages in this repository](docs/wiki/Home.md): using faztudo, lanes,
  phone access, troubleshooting, FAQ and glossary
- [Tasks and approvals](docs/tasks-and-approvals.md) and
  [projects](docs/projects.md)
- [Roadmap](docs/roadmap.md), [architecture](docs/architecture.md),
  [API](docs/api.md), [configuration](docs/configuration.md)

## Contributing

Bug reports, design feedback and small focused pull requests are welcome.
Read [CONTRIBUTING.md](CONTRIBUTING.md) first. In short: no secrets, commits
authored by a person, plain ASCII writing, tests with every fix.

## License

MIT. See [LICENSE](LICENSE).

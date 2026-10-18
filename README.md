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

<!-- Screenshot slot: add docs/images/chat.png and show it here once the
     web app has its first release screenshot. -->

> **Status: pre-alpha, no release yet.** The chat, runs, approvals, Lanes
> dashboard, Office page and LAN mode for phones work today and the project is
> built inside itself. Expect rough edges and changing formats. See the
> [roadmap](docs/roadmap.md).

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

## What works today, and what is planned

| area | state |
| :--- | :--- |
| Channels, threads, direct messages, command palette, grouped messages, markdown with copyable code | works (M1, M1b) |
| Adapters for Claude Code, Codex, Grok, Kimi, Antigravity, OpenCode | works; OpenCode is experimental |
| Original agent avatars with role badges and live state rings | works |
| Office: one room with every member at a desk, live state, lane health and run details | works |
| Worktree write runs, diff view, approvals, commit messages | works |
| Lanes dashboard, health from fresh usage, automatic lane switching | works |
| faztudo MCP server for agents (post, ask, request approval) | works |
| LAN mode: HTTPS, password, phone pairing | works; had an independent security review |
| Phone inbox home, choice cards with lettered options, collapsed agent-to-agent activity | works |
| Write-run sandbox (bubblewrap, no root) | planned (M2) |
| Search, pinned messages, files, notifications, packages | planned (M2) |
| Departments, Chief of Staff, routines | planned (M1b and M2) |
| Signal bridge | planned (M3) |
| Full 2D office scene and agent computers (persistent sandboxes) | planned (M4) |
| Discord bridge, custom adapters | planned (M5) |
| 3D office view, desktop app | planned (M6) |
| Multi-user teams, remote and desktop agent computers | planned (M7) |

## Quick start

There are no release packages yet, so build from source. You need Go 1.25 or
newer, Node.js 22, npm, git and at least one signed-in agent CLI.

```bash
git clone https://github.com/thiagodefreitas/faztudo.git
cd faztudo
make build            # builds the web app and bin/faztudo
bin/faztudo init      # writes ~/.config/faztudo and finds your agent CLIs
bin/faztudo doctor    # checks git, each agent CLI and its version, the port
bin/faztudo serve     # serves http://127.0.0.1:7457
```

Then create a channel, point it at a local git repository and type
`@codex what does this repository do?`. The
[getting started guide](docs/getting-started.md) walks through it, including
LAN mode for your phone.

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
- [Roadmap](docs/roadmap.md), [architecture](docs/architecture.md),
  [API](docs/api.md), [configuration](docs/configuration.md)

## Contributing

Bug reports, design feedback and small focused pull requests are welcome.
Read [CONTRIBUTING.md](CONTRIBUTING.md) first. In short: no secrets, commits
authored by a person, plain ASCII writing, tests with every fix.

## License

MIT. See [LICENSE](LICENSE).

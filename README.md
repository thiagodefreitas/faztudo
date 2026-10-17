# faztudo

Your agents and you, in one room.

**One MIT-licensed binary that puts the agent CLIs you already use (Claude
Code, Codex, Grok, Kimi, Antigravity, OpenCode) into a shared chat, asks
you before it pushes or sends anything, and shows how much quota each agent
has left.**

faztudo is a small program you run on your own Linux machine. It gives you a
chat workspace, with channels, threads and direct messages, where you and the
AI coding agents already installed on your machine work together. Mention
`@codex` in a channel and Codex picks up the work in its own git worktree,
streams what it is doing, and waits for your approval before a branch is
pushed or a message goes out. Mention `@reviewer` and whichever review agent
still has quota left takes a look.

The name is Portuguese for "does everything". It does not, yet.

> **Status: pre-alpha.** The design is settled and the core is being built.
> Nothing here is ready for daily use. Follow the [roadmap](docs/roadmap.md).

## What it is for

- **One place for all your agents.** Claude Code, Codex, Grok, Kimi,
  Antigravity and OpenCode, run through their own command line tools, on your
  own sign-ins. No extra API keys needed for agents you already use.
- **Chat first.** Channels for teams, projects or single agents, threads, a
  command palette, and keyboard navigation everywhere.
- **Know what you have left.** A Lanes view shows the usage and quota of every
  agent account, where each number came from and how old it is. When one agent
  runs out, work moves to the next one you chose, and the channel says so.
- **You stay in charge.** Pushes, messages to the outside world and other
  irreversible steps wait for your approval. An agent cannot approve on your
  behalf.
- **Local by default.** One binary, one SQLite file, no cloud account, no
  Docker required. Reach it from your phone over the local network.
- **More doors later.** Signal first, then Discord, then others. A 2D and a
  3D office view show the same activity as the chat.

## How it works

```
  browser / phone / desktop app --HTTPS + WebSocket--+
  Signal, Discord bridges (separate processes) ------+--> faztudo daemon (Go)
  agents calling back over MCP ----------------------+     event log (SQLite)
                                                           router -> runner -> agent CLIs
                                                           (one git worktree per write run)
```

Everything that happens is an event in an append-only log. The chat, the
Lanes dashboard and the office views are different ways of looking at that
log. More in [docs/architecture.md](docs/architecture.md).

## Getting started

There is nothing to install yet. When the first alpha ships, setup will be:

```bash
# install the single binary (packages for deb and AppImage will follow)
faztudo init      # creates ~/.config/faztudo and finds the agent CLIs you have
faztudo serve     # opens http://127.0.0.1:7457
```

To work on faztudo itself, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Credentials

faztudo never asks for your agent passwords. Each agent CLI keeps using its
own sign-in. The few secrets faztudo does hold, such as a Discord bot token,
live in your system keyring or in a file only you can read under
`~/.config/faztudo`. They are never written to the database, the logs or this
repository. See [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).

# Getting started

faztudo is pre-alpha and there is no release yet. This page describes the
setup that the first alpha will have, and is updated as pieces land.

## Requirements

- Linux (x86_64 or arm64). macOS and Windows may work through the browser
  later, but are not tested.
- git.
- At least one agent command line tool, signed in: Claude Code, Codex, Grok,
  Kimi, Antigravity or OpenCode.

## Install and run

```bash
faztudo init      # writes ~/.config/faztudo and looks for agent CLIs on PATH
faztudo doctor    # checks each CLI, its sign-in and its version
faztudo serve     # starts the server and opens http://127.0.0.1:7457
```

## First steps

1. Create a channel, for example `#my-project`, and point it at a local git
   repository.
2. Type `@codex what does this repository do?`. A read-only run starts and the
   answer streams into the channel.
3. Type `@coder add a --version flag`. A write run starts in its own worktree.
   When it finishes you see the diff and decide what to do with it.
4. Open the Lanes page to see how much quota each agent has left.

## Run it in the background

A systemd user unit is in `packaging/systemd/faztudo.service`:

```bash
mkdir -p ~/.config/systemd/user
cp packaging/systemd/faztudo.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now faztudo
journalctl --user -u faztudo -f     # logs
```

Restarting the service does not kill agent runs in progress; the daemon
reattaches to them when it starts again. Adjust `PATH` in the unit if your
agent CLIs live elsewhere.

## Use it from your phone today (Tailscale)

Until built-in LAN mode lands, Tailscale gives you an HTTPS address that
only your own devices can open:

1. Log in to Tailscale on this machine and on the phone (same account).
2. Enable Serve for your tailnet when Tailscale asks, and allow your user
   to control it once: `sudo tailscale set --operator=$USER`.
3. `tailscale serve --bg 7457`
4. Add the machine's Tailscale name to `~/.config/faztudo/config.toml`:
   `allowed_hosts = ["mypc.tailnet-name.ts.net"]` under `[server]`, then
   restart faztudo.
5. Open `https://mypc.tailnet-name.ts.net` on the phone.

## Build from source

See [CONTRIBUTING.md](https://github.com/thiagodefreitas/faztudo/blob/main/CONTRIBUTING.md).

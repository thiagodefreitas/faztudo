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
faztudo serve     # starts the server and opens an authenticated local browser
faztudo open      # opens the browser again after a restart or token rotation
```

## First steps

1. Create a channel, for example `#my-project`, and point it at a local git
   repository.
2. Type `@codex what does this repository do?`. A read-only run starts and the
   answer streams into the channel.
3. Type `@coder add a --version flag`. A write run starts in its own worktree.
   When it finishes you see the diff and decide what to do with it.
4. Open the Lanes page to see how much quota each agent has left.
5. Type `/status` in any channel for a quick summary: active runs, approvals
   waiting for you and lane health. faztudo answers it itself, so it costs no
   agent quota.

The local browser uses a private token created on first start. Open it with
`faztudo open`, not by typing the server address directly. If you rotate the
token with `faztudo token --rotate`, run `faztudo open` again on each browser.

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

## Use faztudo from your phone

By default faztudo listens only on `127.0.0.1:7457`. You can turn on LAN mode
to use the web app from a phone or tablet on the same Wi-Fi network over
HTTPS.

1. Set a local password on your desktop:

   ```bash
   faztudo passwd
   ```

2. Edit `~/.config/faztudo/config.toml` and turn on LAN mode:

   ```toml
   [lan]
   enabled = true
   listen = "0.0.0.0:7458"
   ```

3. Start (or restart) `faztudo serve`. On first LAN start faztudo generates a
   local certificate authority (ECDSA P-256, 10 years) and a server
   certificate (ECDSA P-256, 1 year) in `~/.local/share/faztudo/tls/` and
   prints one `https://<lan-ip>:7458` URL per non-loopback network address.

4. Install the local CA certificate on your phone so its browser trusts the
   HTTPS connection:
   - Open `http://<lan-ip>:7459` on your phone (plain HTTP helper that serves
     only the CA certificate download and its SHA-256 fingerprint).
   - Compare the SHA-256 fingerprint shown on that page with the fingerprint
     shown on your desktop under **Settings > Devices**.
   - Download `ca.crt` and install it in your phone's certificate settings
     (on iOS: install the downloaded profile in Settings, then enable full
     trust under Settings > General > About > Certificate Trust Settings; on
     Android: Settings > Security > Encryption & credentials > Install a
     certificate > CA certificate).

5. Pair your phone from the desktop browser (opened with `faztudo open`):
   - Open **Settings > Devices** and click **Pair a phone**.
   - Scan the QR code with your phone camera. It opens
     `https://<lan-ip>:7458/pair#<token>` (the token is valid for 5 minutes
     and works once).
   - Enter a device name (for example `Pixel 9` or `iPhone`) and tap
     **Pair device**. You can also sign in at `https://<lan-ip>:7458/login`
     with the password set via `faztudo passwd`.

6. To disconnect a phone at any time, open **Settings > Devices** and click
   **Revoke** next to the device. Its session and any open WebSocket stream
   are closed right away.

## Or use a private network you already have (optional)

LAN mode is the built-in way and needs nothing else. To reach faztudo away
from home, put it behind any VPN or reverse proxy on this machine that only
lets your own devices in. faztudo does not depend on any of them. With LAN
mode on, proxied requests also need a login (faztudo recognizes them by the
forwarding headers a proxy adds, even when they arrive from 127.0.0.1).

Tailscale is one example:

1. Log in to Tailscale on this machine and on the phone (same account).
2. Enable Serve for your tailnet when Tailscale asks, and allow your user
   to control it once: `sudo tailscale set --operator=$USER`.
3. `tailscale serve --bg 7457`
4. Add the machine's Tailscale name to `~/.config/faztudo/config.toml`:
   `allowed_hosts = ["mypc.tailnet-name.ts.net"]` under `[server]`, then
   restart faztudo.
5. Open `https://mypc.tailnet-name.ts.net` on the phone.

When LAN mode is off, the proxy uses local token authentication. On the phone,
visit `https://<your-proxy-host>/auth/local#<token>` once, using the token in
the data directory's `local-token` file. Treat that link like a password. With
LAN mode on, sign in with a LAN session instead.

## Build from source

See [CONTRIBUTING.md](https://github.com/thiagodefreitas/faztudo/blob/main/CONTRIBUTING.md).


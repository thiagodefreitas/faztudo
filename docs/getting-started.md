# Getting started

faztudo is an alpha; the current release is 0.1.0. This page installs it from
a release first. Building from source is at the end.

## Requirements

- Linux (x86_64 or arm64). macOS and Windows may work through the browser
  later, but are not tested.
- git.
- bubblewrap (`bwrap`). Write runs are sandboxed with it.
- At least one agent command line tool, signed in: Claude Code, Codex, Grok,
  Kimi, Antigravity or OpenCode.

## Install from a release

Each release on the
[GitHub releases page](https://github.com/thiagodefreitas/faztudo/releases)
has a `.deb` package and a `.tar.gz` archive for `amd64` and `arm64`, and a
`checksums.txt` file. Replace `X.Y.Z` and the architecture below with the ones
you downloaded.

Check the download first:

```bash
sha256sum --check --ignore-missing checksums.txt
```

On Debian, Ubuntu and similar systems, install the package:

```bash
sudo apt install ./faztudo_X.Y.Z_linux_amd64.deb
systemctl --user enable --now faztudo   # optional: run it in the background
```

The package installs `/usr/bin/faztudo` and a systemd user unit at
`/usr/lib/systemd/user/faztudo.service`.

On other distributions, unpack the archive and put the binary on your PATH:

```bash
tar -xzf faztudo_X.Y.Z_linux_amd64.tar.gz
install -m 0755 faztudo ~/.local/bin/faztudo
```

The archive also contains `systemd/faztudo.service`, the unit described under
"Run it in the background". The web app is embedded in the binary. Install
`git` and `bubblewrap` from your distribution: write runs are sandboxed and
refuse to start without bubblewrap, unless you set `sandbox = "auto"` (see
Configuration).

## Check bubblewrap and Ubuntu 24.04

Write runs refuse to start when the sandbox cannot be built. That is on
purpose. Ubuntu 24.04 and newer restrict unprivileged user namespaces through
AppArmor, which can stop bubblewrap even when it is installed. Check it:

```bash
faztudo doctor
```

Look at these lines:

```
bubblewrap: /usr/bin/bwrap
unprivileged user namespaces: available
systemd user scopes: available
```

If the namespaces line shows an error on Ubuntu 24.04, bubblewrap cannot
create its user namespace as you. The `.deb` from 0.1.1 on handles this: it
installs a small AppArmor profile, `/etc/apparmor.d/faztudo`, only on systems
that restrict them. The profile grants user namespaces to `/usr/bin/bwrap`
alone, when faztudo starts it. faztudo and the agent CLIs it runs without
bubblewrap stay under the system restriction, and programs that bubblewrap
runs get no user namespaces and no capabilities. The package installs the file
only if it is absent or still the packaged one (its first line says so); it
never replaces a symlink or a file you edited. Put local changes in
`/etc/apparmor.d/local/faztudo`, which the profile includes. Removing the
package unloads and removes the profile. With the tarball, install the same
profile from its `apparmor/faztudo` file:

```bash
sudo install -m 0644 apparmor/faztudo /etc/apparmor.d/faztudo
sudo apparmor_parser -r /etc/apparmor.d/faztudo
faztudo doctor
```

The profile only applies to `/usr/bin/faztudo` and `/usr/bin/bwrap`; if you
put either somewhere else, change the paths in it. Read-only runs work
without it. If you accept unsandboxed write runs instead, set
`sandbox = "auto"` under `[runs]` in `config.toml`. The "systemd user scopes" line only matters
for the memory and task limits.

## Install and run

```bash
faztudo init      # writes ~/.config/faztudo and looks for agent CLIs on PATH
faztudo doctor    # checks each CLI, its sign-in and its version
faztudo serve     # starts the server and opens an authenticated local browser
faztudo open      # opens the browser again after a restart or token rotation
```

`faztudo connect --json` is for other programs, such as the desktop app. It
prints `{"url","code","version"}`: the loopback address, a single-use sign-in
code and the daemon version. The local token is never printed. Without
`--json` it prints a one-time sign-in link for you.

`faztudo stop` cancels every agent run in progress and then stops the
systemd user unit, if that unit is the faztudo answering at the configured
address. A faztudo you started by hand keeps running; stop it where you
started it.

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

## The desktop app (optional)

The desktop app is faztudo in a window of its own, with a tray icon and a
launcher entry. It is the same web app the browser shows, signed in with a
one-time code, so nothing changes in how faztudo works or what it can reach.

Releases from 0.1.4 have two desktop downloads per architecture:

- `faztudo-desktop_X.Y.Z_linux_amd64.deb` needs the faztudo package. Install
  both:

  ```bash
  sudo apt install ./faztudo_X.Y.Z_linux_amd64.deb ./faztudo-desktop_X.Y.Z_linux_amd64.deb
  ```

- `faztudo-desktop_X.Y.Z_linux_amd64.AppImage` runs on its own and carries a
  copy of faztudo. Make it executable and open it. On Ubuntu 24.04 and later
  the system only lets packaged programs create the sandbox that write runs
  use, so with the AppImage alone agents can read and answer but write runs
  do not start. The app says so when it opens. Install the faztudo `.deb` to
  lift that; the AppImage then uses the installed faztudo.

The checksums are in `checksums-desktop.txt`.

What the app does:

- It finds faztudo (the package, `~/.local/bin` or your PATH), starts it if it
  is not running (through the systemd user unit when there is one) and signs
  in.
- Closing the window hides it; faztudo and its agents keep working. Open it
  again from the tray menu or by starting the app again.
- **Quit** in the tray menu asks whether to leave faztudo running or to stop
  it and cancel its agent runs.
- **Start at login** in the tray menu adds the app to your session's
  autostart, opening in the tray.
- Notifications for mentions, approvals and failed runs appear as desktop
  notifications, as they do in a browser.
- Once a day at most it asks GitHub whether a newer release exists, and if so
  the tray menu offers the download page. It never updates itself. Set
  `FAZTUDO_NO_UPDATE_CHECK=1` to turn the check off.
- Links to other sites open in your browser, never in the app window.

On GNOME the tray icon needs the AppIndicator extension, which Ubuntu
includes. Without a tray, start the app again to bring its window back.

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

You need Go 1.25 or newer, Node.js 22, npm, git and bubblewrap.

```bash
git clone https://github.com/thiagodefreitas/faztudo.git
cd faztudo
make build            # builds the web app and bin/faztudo
bin/faztudo init
bin/faztudo doctor
bin/faztudo serve
```

More in
[CONTRIBUTING.md](https://github.com/thiagodefreitas/faztudo/blob/main/CONTRIBUTING.md).

## Next

- [Tasks and approvals](tasks-and-approvals.md): give an agent a task and
  decide in the inbox.
- [Projects](projects.md): group channels and a team, and read the digest.


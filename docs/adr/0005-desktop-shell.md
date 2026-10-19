# 0005: The desktop app is a thin Tauri client

Status: accepted, 2026-10-19

## Context

faztudo runs as a local daemon with a web UI. A tray icon, a window of its own
and a launcher entry would make it feel like an app. The daemon checks the
exact origin and host of every request (see `SECURITY.md`), and its write
runs depend on bubblewrap and the AppArmor profile that ships with the
`.deb`. A desktop shell must not weaken either.

## Decision

Build the desktop app with Tauri 2, as a thin client.

- **One window, the daemon's own origin.** The window loads
  `http://127.0.0.1:<port>`, the same origin a browser uses. The existing
  exact-origin and host checks stay as they are. Nothing is bundled into the
  shell that the daemon already serves.
- **No Tauri IPC for that origin.** The page gets no Tauri commands, no file
  system access and no shell access. It is a web page in a window.
- **Locked navigation.** The window may only navigate inside that origin. Any
  other link opens in the system browser.
- **Sign-in with a one-time code.** The shell runs `faztudo connect --json`,
  reads `{"url","code","version"}` and loads `<url>/auth/local#<code>`. The
  code works once and expires. The local token is read only by Go code and
  never reaches the shell, a command line or a log.
- **The daemon stays `/usr/bin/faztudo`.** It runs under its systemd user
  unit from the `.deb`, so the AppArmor profile keeps attaching to that path.
  The shell starts and talks to the daemon; it does not embed it.
- **The AppImage carries a faztudo binary as a sidecar.** On Ubuntu 24.04 and
  later, without the faztudo `.deb`, no AppArmor profile lets bubblewrap
  create user namespaces for it. In that case the AppImage runs read-only work
  only and says so plainly in the window. Write runs need the `.deb`.
- **Quit asks.** Quit from the tray asks whether to stop faztudo and its
  running agents, or to leave them running.
- **Two packages.** `faztudo` (the daemon) and `faztudo-desktop`, which
  depends on `faztudo`. Builds for amd64 and arm64.
- **Update notice only.** The shell tells the person when a newer release
  exists and links to it. It does not update itself.

## Alternatives considered

- **Wails.** Its tray support is alpha. Its custom URL scheme would mean a
  different origin, so the daemon's origin checks would have to be loosened.
- **Electron.** It works, but ships a full browser. The download is far larger
  than the app it wraps.
- **The PWA.** It has no tray and no autostart. It stays as the zero-install
  path, including on phones.

## Consequences

- The security model is unchanged: the shell is one more local client that
  signs in with a one-time code.
- The daemon API gains no new surface; `faztudo connect` uses the existing
  `/api/v1/auth/local/code` endpoint.
- The AppImage is a weaker package than the `.deb` on Ubuntu 24.04 and later.
  The window must say why, not hide it.

## Open risk

WebKitGTK can start its own sandbox, which uses user namespaces, and Ubuntu
24.04 restricts those through AppArmor. The spike below measured that it does
not block the window on a stock 24.04 install. The tray and notifications are
still to be measured on a real desktop.

## Spike results (2026-10-18)

- A minimal Tauri 2 window that loads the daemon origin builds in about
  45 s to an 11 MB release binary, on Ubuntu 22.04 and 24.04.
- On Ubuntu 24.04.5 with `apparmor_restrict_unprivileged_userns=1`,
  WebKitGTK 4.1 (2.52.6) starts its web processes unconfined in the host
  user namespace: it does not use its own bubblewrap sandbox there, so the
  restriction does not block it.
- On an Ubuntu 22.04 X11 desktop with an NVIDIA GPU the window loads the
  daemon, signs in with a one-time code and has WebGL 2.
- The office, tasks and approvals pages looked stuck in a fresh window. The
  cause was not WebKit: the web app replayed the whole event log on every
  load (`after_seq` 0), which also stalls a fresh Chromium. The client is
  changed to start the stream at the current head.
- Not measured yet: the tray on GNOME and KDE, and web notifications.

## Build results (2026-10-19)

- The app is `desktop/` in this repository. Release builds run on Ubuntu
  22.04 runners for amd64 and arm64 (a dry run of the release job built all
  four packages).
- Sizes from that run: the `.deb` is about 2.6 MB and depends on the faztudo
  package and the system WebKitGTK; the AppImage is about 85 MB, because it
  carries WebKitGTK and an 18 MB faztudo.
- Both desktop `.deb` packages install with every library resolved in clean
  Debian 12 and Ubuntu 24.04 containers (`scripts/install-test.sh` with
  `DESKTOP_DEB`).
- On an Ubuntu 22.04 desktop the AppImage, with no faztudo installed, copies
  its faztudo out of the mount, starts it, signs in and loads the app.
- `faztudo stop` was added so Quit can cancel runs without the shell holding
  the token. It stops the systemd user unit only when the unit's process is
  the one listening on the configured address.
- An independent review found eight issues before the first release, the
  worst being that the `.deb` layout was mistaken for an AppImage; all were
  fixed before merging.
- Released in 0.1.4. Measured on the author's desktop before the release:
  the window opens signed in, and the version notice appears when the app
  and the running faztudo differ. Not measured yet on a real desktop: the
  tray menu, hide on close, the Quit dialog, notifications and Start at
  login.

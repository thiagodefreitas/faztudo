# Troubleshooting

Start with `faztudo doctor`. It checks the config, the data directory, git
and each agent CLI it can find.

## An agent is missing

Run `faztudo agents detect`. faztudo looks for the CLIs on `PATH`. If you run
faztudo under systemd, the unit sets its own `PATH`; edit the `Environment=`
line in `packaging/systemd/faztudo.service` so it includes the directory of
your CLIs.

## The sandbox refuses to start

Write runs need bubblewrap, and by default they fail instead of running
without it. The channel notice says why. Run `faztudo doctor` and read these
lines:

- `bubblewrap: unavailable`: install the `bubblewrap` package.
- `unprivileged user namespaces:` followed by an error: the kernel or
  AppArmor blocks bubblewrap. Ubuntu 24.04 does this by default. See
  [the getting started guide](https://thiagodefreitas.github.io/faztudo/getting-started/).

If you accept running write runs without the sandbox, set `sandbox = "auto"`
under `[runs]` or on one lane. In that mode a run that fell back to no sandbox
does not run the channel's test command, because that would run code the
agent wrote as you.

## A run was killed for memory

A run that ends with exit 137 was stopped by the memory limit
(`sandbox_memory_max` under `[runs]`). Test suites that start many
workers are the usual cause, and several write runs at once add up. Raise the
limit under `[runs]` in `config.toml`, cap the workers of the test command, or
run fewer write runs at the same time. If `faztudo doctor` says systemd user
scopes are unavailable, the limit is not applied.

## OpenCode errors

OpenCode is experimental. A run can fail with a message from OpenCode itself,
for example that the selected model needs a newer OpenCode version: update
OpenCode and try again. If the provider cannot be reached, check that the lane
keeps the network (`sandbox_network` is not false) and that OpenCode is signed
in. The sandboxed write run with a model is not fully verified yet; see
`SECURITY.md`.

## A mention does nothing

- Check the handle exists: type `@` and look at the suggestions.
- If the channel says the message is queued, every lane for that persona is
  busy. It starts when one frees up.
- If a lane is exhausted or unavailable, the channel shows a notice. Use
  `/status` to see lane health.

## A write run says there is nothing to do, or cannot start

The channel needs a repository path that is a local git work tree. Set it in
the channel settings.

## Merge is refused

The card stays pending and shows the reason. Merge needs the channel
repository to be clean, so commit or stash your own changes. If the branch
moved, faztudo replays the run's commit on top; when that conflicts it names
the files. If the repository is on a different branch than when the run
started, switch back. Or choose Keep and merge the branch yourself.

## The browser does not open

`faztudo serve` opens the browser only when `open_browser` is true, output is
a terminal and a display is set. Otherwise open `http://127.0.0.1:7457`
yourself, or pass `--no-open` to skip the attempt.

## The port is in use

Another process holds 7457. Start with `faztudo serve --listen 127.0.0.1:7460`
or change `listen` under `[server]`. The address must be a loopback address.

## LAN mode will not start

Set a password first with `faztudo passwd`. LAN mode refuses to start without
one.

## The phone shows a certificate warning

The phone does not trust your local CA yet. Follow
[Phone and LAN access](Phone-and-LAN-access): download `ca.crt` from the
plain HTTP page, compare its fingerprint with the one in **Settings >
Devices**, and install it. On iOS the profile must also be enabled under
Certificate Trust Settings. Open the pages with the address faztudo printed
at start.

## A lane shows unknown

There is no fresh number for it. Not every CLI reports usage, and numbers
older than 15 minutes are not used. See [Lanes and quota](Lanes-and-quota).

## Reporting a bug

Open an issue on GitHub with what you did, what you expected and the output
of `faztudo version` and `faztudo doctor`. Remove anything private first.

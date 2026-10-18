# Troubleshooting

Start with `faztudo doctor`. It checks the config, the data directory, git
and each agent CLI it can find.

## An agent is missing

Run `faztudo agents detect`. faztudo looks for the CLIs on `PATH`. If you run
faztudo under systemd, the unit sets its own `PATH`; edit the `Environment=`
line in `packaging/systemd/faztudo.service` so it includes the directory of
your CLIs.

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

Merge fast-forwards the channel repository's current branch and needs that
repository to be clean. Commit or stash your own changes, then try again, or
choose Keep and merge the branch yourself.

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
[Phone and LAN access](Phone-and-LAN-access). On iOS the profile must also be
enabled under Certificate Trust Settings.

## A lane shows unknown

There is no fresh number for it. Not every CLI reports usage, and numbers
older than 15 minutes are not used. See [Lanes and quota](Lanes-and-quota).

## Reporting a bug

Open an issue on GitHub with what you did, what you expected and the output
of `faztudo version` and `faztudo doctor`. Remove anything private first.

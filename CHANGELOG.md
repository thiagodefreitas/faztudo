# Changelog

All notable changes are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.8] - 2026-10-22

### Added

- Lessons: Teach @persona on an agent answer saves a short correction for
  that persona, in one channel or everywhere. Every later run of the
  persona gets its lessons, shown in the run's Context tab, and they can be
  edited or deleted from the members panel and the Organization page.
- Repeat this: a finished run's answer menu turns its request into a
  scheduled routine. Routines made in the app can be deleted from the
  Routines page.
- Today: a brief at the top of the home page with what needs you, what
  finished or failed since your last visit, what runs now and which lanes
  are short.
- Approval rules: Always merge changes like this here on a merge card
  creates a rule for the channel, with path globs and a line cap. A rule
  needs a channel test command that passed, never applies to a run a
  routine started, never passes dot paths, build and lock files, scripts,
  executables, symlinks or submodules, and never pushes.
- Cost per run: All work cards show tokens and estimated cost when known,
  and the Lanes page sums today's tokens and cost per lane with how many
  runs were measured. Codex runs are now measured.
- Dictation: a microphone button in the message box uses the browser's
  speech recognition.
- Routine triggers for GitHub: a failing CI run, a new issue or a new pull
  request, read with your signed-in gh. The item reaches the agent as
  labelled data.
- Scout: a read-only routine that files suggestions with evidence in the
  inbox. Make a task accepts one; Dismiss with a reason teaches the scout.
- Drafts before sending: agent messages to a Signal group or a direct
  recipient wait for Send, Edit and send, or Don't send. Note-to-self is
  unchanged.
- Agent computers v1, off by default: with `[computers] enabled`, each
  persona's write runs keep a persistent home and caches with limits and a
  reset button. See ADR 0006.

### Changed

- A read run passes over lanes whose CLI has no read-only mode and waits for
  one that has, instead of failing with "has no read-only mode".
- Every message in a run's transcript names its author as human or agent,
  and its further lines are indented, so a message cannot pose as one from
  you.
- Database migrations from 012 on run in order, each once.
- Listing routines is for humans only: an agent token gets 403.

## [0.1.7] - 2026-10-20

### Added

- The Tasks page has an All work view: every run of the last day in Queued,
  Running, Needs you, Done and Failed, with the request, the channel and who
  delegated it.
- A run's Context tab shows exactly what the agent was given, section by
  section with sizes: the channel summary, Working now, pins, the
  transcript, the request and the instructions.
- In the 2D office, a working desk shows the start of its request and the
  elapsed time under the name.
- The README, the site and a new wiki page describe how faztudo is built
  with faztudo.
- The Playwright browser tests run in CI.

### Changed

- A lane whose last run finished cleanly shows as available for an hour,
  with the age in its reason, instead of unknown.
- The 2D office lays its rooms out to fill the window, so a wide screen gets
  more columns. Agents out of quota keep their avatar, dimmed, with one
  "out of quota" tag instead of two. Lane names on the office wall are
  readable.
- The channel summary is labeled as older context in agent prompts, and
  summaries keep only the current state of facts that changed.
- Lane cards hide a runs-today count left from a previous day.

### Security

- A signed-in member outside a private channel could read that channel's
  runs, their output, diffs and stored prompts by run id. Every run route now
  answers 404 unless the caller can see the run's channel, and the run list
  leaves those runs out.

### Fixed

- Channel summaries never worked: the prompt went over the 128 KiB a single
  command-line argument can hold. Summaries now clip long messages and work
  in passes, run transcripts keep the same budget, and a failing summary
  waits 30 minutes before the next try instead of retrying every minute.
- A lane marked exhausted came back only when a run tried it, so a lane
  nobody tried stayed exhausted on every screen. It now comes back at its
  reset time.
- Grok answers no longer run sentences together ("can appear.The prompt").
- Answers drop the closing lines some CLIs repeat when late test output
  arrives.
- The members button in the channel header no longer overlaps the channel
  name.

## [0.1.6] - 2026-10-20

### Fixed

- Switching channels no longer stacks the previous channels' messages and
  notices under the new one: the channel page gave three of its parts the
  same key, so old ones stayed on screen.

## [0.1.5] - 2026-10-20

### Added

- Agent prompts show active work and open handoffs in the channel, plus pinned
  messages before the rolling chat history.
- Delegated results return to the delegating agent in one read-only collect
  run. Request budget counts survive a restart. Runs record the thread and
  handoff of their trigger, so the chat shows a request's pieces after a
  reload without opening the thread; the collect digest shows as one line.
- Agents can read a whole thread, search messages and list the work handed
  out for their request (`read_thread`, `search_messages`, `list_handoffs`),
  inside their own project only. `delegate` takes an optional `done_when`.

### Changed

- `/lane codex` works as a short name for `codex/default` when it matches
  exactly one of the persona's lanes.
- The chat stays smooth while agents stream: each live event updates only
  the data it touches, and the transcript no longer redraws every second.
- Unsent text is kept per channel and per thread, across channel switches
  and reloads, and a reply that fails to send comes back into the box.
- The composer takes focus when a channel opens on a desktop, Send is
  disabled with nothing to send, and small controls are easier to tap on
  a phone.
- The live connection retries with growing pauses instead of every 400 ms,
  and reconnects at once when the network or the tab comes back.

### Fixed

- Failure reasons and failed checks are readable: no escape codes, no echoed
  patches, killed runs say which signal, and a failed check shows the failing
  tests or compiler errors instead of dozens of passing packages. Long check
  output and reasons fold behind "Show all" on the run and approval cards.
- A run left as running when faztudo stopped before saving its process
  state is now failed on the next start instead of staying active forever.
- A restart no longer moves a run whose approval was already decided back
  to waiting for approval.
- agy write runs can use their shell tool again: agy gets a private copy of
  its bin directory, since it rewrites a launcher there before each command.
- A lane out of quota without a stated reset time no longer stays exhausted
  until a manual reset: a named window ("5-hour usage limit") sets the
  reset, and otherwise the lane is tried again after an hour.
- A run's saved patch keeps its last line and never picks up git warnings,
  so it applies with `git apply` as downloaded.
- The Lanes page measures Codex again when its runs are sandboxed: a run's
  rate limit readings are kept before its private Codex home is deleted.
- Claude read runs no longer use plan mode, where the model wrote a plan
  file under `~/.claude/plans` and the Chief of Staff and department leads
  answered with a plan instead of calling the delegate tool. They stay
  read-only through an allow-list.
- A missing agent CLI fails the run with "executable file not found" again,
  instead of exit 127 or a bare "exit -1".
- Agent runs survive a restart of faztudo. A run still going finishes
  normally with its answer and approval, and a mention waiting for a free
  lane is kept and started again. A run that cannot be recovered is
  reported in its channel instead of stopping faztudo from starting.
- Opening a run card no longer scans the whole event log, and reads no
  longer wait behind writes, so a large workspace stays responsive.
- A phone or tab that drops off the network is noticed and released;
  before, each one kept polling the database until it reconnected.
- Routines triggered by channel messages keep working after a database
  read error.
- An approval stays consistent when faztudo stops between a merge and
  its record.
- `faztudo stop` no longer gives up when a run waits for approval or for
  a free lane; those runs are kept.
- A mention inside inline code, a code block or a quoted line no longer
  starts a run or notifies anyone.
- Channel summaries were never written when the cheapest lane had no
  read-only mode (agy); such lanes are now skipped, and a summary attempt
  counts as a run only when it really starts.

## [0.1.4] - 2026-10-19

### Added

- The desktop app for Linux: faztudo in its own window with a tray icon,
  as a `.deb` that needs the faztudo package and as an AppImage that carries
  faztudo, for amd64 and arm64. Closing hides to the tray, Quit asks whether
  to leave faztudo running, Start at login, desktop notifications, and a
  daily update notice that never updates by itself.
- `faztudo stop` cancels the agent runs in progress and stops the systemd
  user unit.
- Signal bridge, step 2: `faztudo bridge signal` translates between the local
  bridge protocol and a separate user-installed signal-cli process. A link
  command shows a terminal QR code, and doctor checks for the linked account.
  Signal approval replies remain for step 3.
- `faztudo doctor` reports whether the AppArmor profile is installed and
  whether this faztudo is the packaged one, on systems that restrict user
  namespaces.

### Fixed

- A lane that hit its quota keeps its reset time across a daemon restart
  instead of staying exhausted until changed by hand.

## [0.1.3] - 2026-10-18

### Added

- Office zoom: scroll or pinch to zoom the 2D office, drag to pan, click a
  department, pod or the Director area to zoom to it, and use the corner
  control or the keyboard to zoom, fit all or jump to an area. In 3D,
  "Jump to" moves the camera to that area.
- `faztudo connect --json` prints the daemon address and a one-time sign-in
  code, never the token, for programs such as the desktop app.
- The demo data shows a fuller organization, with Engineering, Quality and
  Product departments.

### Fixed

- The web app starts the live event stream at the current head instead of
  replaying the whole event log, so a large workspace opens quickly.

## [0.1.2] - 2026-10-18

### Added

- Compare mode: mention a write persona with `x2` to run one request on two
  lanes, then merge one candidate, discard both or combine them. Only people
  can start a compare.
- A worked organization example (`docs/examples/organization.toml`) and a
  guide to start a new project from an existing one.
- Signal bridge, step 1: the bridge protocol, a shared path for posting and
  resolving approvals, and the bridge supervisor. Off by default; the Signal
  program itself comes next.

### Fixed

- Ubuntu 24.04: the AppArmor profile now gives user namespaces to
  bubblewrap only; everything else faztudo starts, and everything
  bubblewrap runs, gets none. The package no longer replaces a profile you
  edited.
- A run that hits its timeout ends instead of being retried.
- A run killed for memory says so and records its peak memory; lane health
  shows the CLI's own quota line instead of agent output.
- Lane probes for CLIs without a probe say so instead of "resource
  conflict".
- The approvals inbox no longer shows resolved approvals as waiting, and
  hidden lanes stay hidden.
- The compare card reads only its channel's events (new index, migration
  008) instead of the whole event log.

## [0.1.1] - 2026-10-18

### Fixed

- Ubuntu 24.04: the `.deb` installs an AppArmor profile so the bubblewrap
  sandbox can create its user namespace; without it every write run refused
  to start. Only installed where the kernel restricts user namespaces, and
  removed with the package. The tarball carries the same profile.
- Sandbox memory: `sandbox_memory_max` defaults to `auto` (a quarter of RAM,
  2G to 8G), a write run waits for free memory instead of being killed, and
  the web tests use at most four workers.
- A `/lane` override a persona cannot use says which lanes it can.
- Long agent answers keep their beginning, where the summary is, instead of
  only their last 8 KB; the full text stays in the run output.

## [0.1.0] - 2026-10-18

First usable alpha.

### Chat

- Channels, threads and direct messages with a live event stream, an inbox
  home, a command palette and search over message bodies.
- Pins, file attachments (images inline, other files as cards) and browser
  notifications for mentions, approvals and failed runs.
- Run cards that start with one plain sentence, folded details, long answers
  folded after about twelve lines, and a run timeline with tokens and an
  estimated cost when the CLI logs them.
- Project homes, a sidebar grouped by project and a "Needs you" count.
- A catch-up card when you open a busy channel, a New divider with a jump
  to the first unread message, day dividers, grouped messages, filters for
  mentions, runs, decisions and files, and a list of the channel's threads.

### Agents and lanes

- Runs through Claude Code, Codex, Grok, Kimi, Antigravity and OpenCode, read
  only or in a git worktree, with verification, approvals and merge.
- A faztudo MCP server for agents: read context, post, ask a human, request
  approval, delegate.
- Lanes with usage read from the CLIs' own logs, health, announced switching,
  history, cost estimates, alerts and rolling channel summaries.

### Tasks and approvals

- Tasks: a directive for one agent with scope, checks and acceptance,
  started from the composer or `/task`, tracked on a board per project.
- An approvals inbox with every pending decision across channels, diff
  previews, an editable commit message and one-key answers; refused merges
  say why.
- Merge replays a run's commit when the branch moved, names conflicting
  files, and refuses when the repository switched branches.

### Organization

- A Director, departments, specialists and cross-functional projects, with
  project-scoped routing.
- New project and team channel dialogs, a members panel, project settings,
  archiving, and a daily digest on each project home.
- A Chief of Staff that delegates work, routines on a schedule or on new
  messages, and `faztudo init --template solo|team|empty`.

### Office

- A 2D office where every agent has a desk, a character and a live state,
  and a lazy loaded 3D office with the same characters, keyboard control and
  a side panel per desk.

### Security

- Local API calls need a private token, also on loopback.
- Write runs are sandboxed with bubblewrap and fail closed by default
  (`sandbox = "required"`): a read-only shared `.git` except objects,
  per-run state, a stripped environment, and the test command runs inside
  the sandbox. Host git ignores repository hooks, filters, external diff
  programs and merge drivers. `sandbox = "auto"` is an explicit opt-in.
- Read runs and channel summaries start in an empty scratch folder with the
  stripped environment, never in the data directory.
- Private channels, their messages, events and files are visible only to
  members, and every change to channels, lanes, runs, approvals, tasks and
  the organization is human-only.
- Known limits for 0.1.0: write runs keep network access by default, CLI
  OAuth refresh files stay writable inside the sandbox, and read runs are
  not sandboxed. See SECURITY.md.

### Phone and LAN

- LAN mode with HTTPS from a local certificate authority, password login and
  phone pairing by QR code, with revocable devices.
- An installable phone app (PWA) that caches only the app shell.

### Packaging

- Single binaries for Linux amd64 and arm64 with the web app embedded, a
  tarball, a `.deb` with a systemd user unit, and checksums.

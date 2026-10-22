# Configuration

faztudo follows the XDG directory layout:

| path | holds |
| :--- | :--- |
| `~/.config/faztudo/config.toml` | server settings |
| `~/.config/faztudo/lanes.toml` | lanes and personas |
| `~/.config/faztudo/secrets` | secrets when no keyring is available (mode 0600) |
| `~/.local/share/faztudo/faztudo.db` | the event log and projections |
| `~/.local/share/faztudo/local-token` | local browser and CLI authentication token (mode 0600) |
| `~/.local/share/faztudo/worktrees/` | git worktrees for write runs |
| `~/.local/share/faztudo/runs/` | raw run output |
| `~/.local/share/faztudo/tls/` | local CA and LAN server certificates (mode 0700, keys 0600) |

`faztudo init` writes commented starting versions of both files.

## config.toml

```toml
[server]
listen = "127.0.0.1:7457"
open_browser = true
max_upload_mb = 25          # largest attached file

[lan]
enabled = false
listen = "0.0.0.0:7458"
ca_listen = "0.0.0.0:7459"

[runs]
default_timeout = "30m"
context_messages = 40       # recent messages sent to an agent
summary_every = 20         # update the rolling channel summary after this many new messages
context_limit_tokens = 128000 # model context estimate used for rollover
# summary_lane = "kimi/default" # optional; otherwise the cheapest healthy lane
sandbox = "required"        # required (default), auto or off for write runs
sandbox_memory_max = "auto" # auto (a quarter of RAM, 2G to 8G) or a size such as "4G"
sandbox_tasks_max = 4096   # systemd user scope, when available; threads count as tasks
sandbox_read_only = []      # extra absolute toolchain paths to mount read-only
request_max_runs = 6          # runs one request may start by delegation
request_max_premium_runs = 2  # of those, runs on a premium lane
collect_delegations = true     # one read-only follow-up after delegated results

[routines]
timezone = ""     # IANA name such as "Europe/Berlin"; empty uses this machine's zone
max_per_day = 20  # routine runs started per local day, all routines together
poll_interval = "5m" # GitHub event checks per repository; minimum 1m
```

`max_upload_mb` (under `[server]`) caps one attached file. Files are stored
under `files/` in the data directory, named by the SHA-256 of their content,
mode 0400, and are served with a type sniffed from the bytes. Only PNG, JPEG,
GIF and WebP show inline; every other file downloads. An agent sees the text
of small (64 KB or less) plain-text attachments of the message that started
its run through `read_context`; other files are listed by name and size.

`allowed_hosts` (under `[server]`) lists extra host names accepted from a
reverse proxy running on this machine, for example
`allowed_hosts = ["mypc.tailnet-name.ts.net"]` with `tailscale serve`.
Requests must still arrive from 127.0.0.1; the proxy decides who may
connect. With LAN mode on, proxied requests need a LAN session. With LAN mode
off, they need the local cookie, set once by visiting the proxy's
`/auth/local#<token>` link. The token is in the data directory's `local-token`
file; treat the link like a password. Restrict proxy access to your own
devices.

`faztudo serve` opens `/auth/local#<token>` with `xdg-open` after binding when
`open_browser` is true, stdout is a terminal, and `DISPLAY` or
`WAYLAND_DISPLAY` is set. Use `faztudo serve --no-open` to skip this, or
`faztudo open` to open it later. The token is created on first start in the
data directory and reused across restarts. `faztudo token --rotate` replaces
it and signs local browsers out. CLI API requests send it as a bearer token.
When `[lan] enabled = true`, `faztudo serve` also binds the HTTPS LAN
listener on `lan.listen` (default `0.0.0.0:7458`) and the plain-HTTP CA
helper listener on `lan.ca_listen` (default `0.0.0.0:7459`). Run
`faztudo passwd` before starting LAN mode for the first time.

With `required` (the default), write runs use bubblewrap on Linux and fail at
once, naming the reason, when it or unprivileged user namespaces do not work.
`auto` is an opt-in: it posts one channel notice per run if it falls back to
the old process mode, and then skips the channel test command, which would
otherwise run unsandboxed. `off` disables the sandbox. Each `[[lane]]` may set `sandbox = "auto"`, `"off"` or `"required"`
to override `[runs].sandbox` for write runs on that lane. Without it, the
global value applies. Existing config files that explicitly say `sandbox = "off"` keep
that setting until you change it. The worktree is writable, except its `.git`
file. The shared git directory is read-only except its objects. The run's
worktree metadata is a writable copy, isolated from host Git, and the run's
own branch `fz/<run id>` is a private writable copy of its ref and reflog, so
the agent can commit but cannot move `main` or any other ref.
`objects/info` stays read-only while Git can write new objects. The channel
test command runs inside the same sandbox. Host-side git commands
on an agent worktree name its real git directory and work tree explicitly, and
disable fsmonitor, hooks, external diffs, textconv and configured Git filters.
Worktree creation and the final merge disable those filters too;
a changed `.git` file or worktree admin pointer fails the run as tampered with.
Codex runs with a `CODEX_HOME` under the run's state directory: your
`config.toml`, `AGENTS.md`, `packages/`, `plugins/`, `skills/` and `rules/` are
read-only, `auth.json` is writable, and the rest is fresh. Codex's own sandbox
is disabled only inside bubblewrap. Kimi and Agy use private writable homes
with read-only settings and tools. Kimi's credential and OAuth directories are
writable for token refresh; Agy's project config has private writable state.
OpenCode uses private XDG data for its database and logs, with its auth file
bound for refresh. Other CLI config and sign-in paths are read-only except
existing OAuth credential files: Claude's `.claude/.credentials.json`,
Codex's `.codex/auth.json`, Grok's `.grok/auth.json`, Agy's
`.gemini/antigravity-cli/antigravity-oauth-token`, and OpenCode's
`.local/share/opencode/auth.json`. Session state and build
caches are writable in a private per-run directory. Home `PATH` entries named
`bin`, `shims` or `scripts` and the Go module cache are read-only. Go and Node
version directories are mounted as roots. Add absolute paths to
`sandbox_read_only` for other required tools. Paths must exist; the sandbox
does not install missing tools or download missing Go modules into its
read-only module cache. The rest of home is hidden.
`faztudo doctor` reports
bubblewrap, user namespace and systemd user-scope availability. When a scope
works, `sandbox_memory_max` and `sandbox_tasks_max` cap memory and tasks.
`sandbox_memory_max = "auto"` is a quarter of total RAM, at least 2G and at
most 8G. Before a sandboxed write run starts, faztudo compares `MemAvailable`
in `/proc/meminfo` with that limit. When less is free, the run stays queued,
the channel gets one notice ("waiting for memory: N GB free, the run needs M
GB"), and the run starts once memory frees up.
Read runs are unchanged. See [SECURITY.md](../SECURITY.md) for limits.

### Agent computers

Agent computers are off by default. Enable them only with the required write
sandbox and a working systemd user session:

```toml
[runs]
sandbox = "required"

[computers]
enabled = true
disk_soft_max = "10G"
# cpu_quota = "200%"  # optional aggregate CPU cap
```

Each persona gets its own `computers/<handle>/home` and `caches` under the
faztudo data directory. Write runs use that home and keep the Go, npm and XDG
caches between runs. Read runs do not use a computer. One write run per persona
uses the computer at a time; another waits in the queue. A computer at or over
`disk_soft_max` refuses new write runs until it is reset or the limit is raised.
The Organization page shows its state, disk use and last reset. The Director
can reset it there or use `POST /api/v1/computers/{handle}/reset`; the API also
has `GET /api/v1/computers`. Both routes are human-only.

Reset stops the computer's systemd slice and removes its home and caches only
when no write run or slice process remains. It cannot undo OAuth changes made
through the host credential bind, shared Git object writes or anything already
sent over the network. The home cannot contain `.ssh`, `.config/gh`,
`.git-credentials` or `.netrc`. Git hooks, Go environment settings, npm user
config and shell startup settings are pinned outside the persistent home; tools
installed in it must be called by path. Credential copies containing a bound
token verbatim are removed from the home and caches after each write run.
Use `required` when a lane's `sandbox_network = false` must be enforced;
an `auto` fallback runs with the host network. A networkless sandboxed run
does not receive the faztudo MCP config or prompt note.

## lanes.toml

A lane is one agent CLI with one model route. A persona is a name you can
mention, backed by an ordered list of lanes.

```toml
[[lane]]
id = "claude/opus"
cli = "claude"
model = "opus"
cost_class = "premium"
capacity = 1
conserve_at = 80
sandbox_network = true       # default; false hides the network in write runs
# sandbox = "required"      # optional override of [runs].sandbox for this lane
# plan_limit_tokens = 1000000 # optional manual limit for token-based usage (claude, grok)
# usd_per_million_input = 2.0  # optional estimate, not billing; also prices each run's tokens
# usd_per_million_output = 8.0
# usd_per_million_cached = 0.5

[[lane]]
id = "codex/default"
cli = "codex"
cost_class = "standard"
capacity = 2
conserve_at = 80

[[lane]]
id = "kimi/default"
cli = "kimi"
cost_class = "cheap"
capacity = 1
conserve_at = 80

[[persona]]
handle = "coder"
display_name = "Coder"
role = "Implements changes in a worktree"
lanes = ["codex/default", "claude/opus", "kimi/default"]
mode = "write"

[[persona]]
handle = "reviewer"
display_name = "Reviewer"
role = "Reviews diffs and plans"
lanes = ["claude/opus", "codex/default"]
mode = "read"
```

A persona can also have a `description` (shown on the Organization page) and
`instructions`: standing instructions that go at the top of every prompt that
persona runs. Instructions stay in `lanes.toml`; they are not sent to the web
app.

### Departments and projects

A department is a team of agents with a lead. A project groups channels and a
repository, and has the departments and single specialists assigned to it.
See [organization](organization.md) for the idea, and
[docs/examples/organization.toml](https://github.com/thiagodefreitas/faztudo/blob/main/docs/examples/organization.toml)
for a worked example.

```toml
[[department]]
handle = "engineering"          # @engineering goes to the lead
display_name = "Engineering"
lead = "coder"                  # a persona handle or a lane's CLI name
members = ["coder", "reviewer"]

[[project]]
handle = "faztudo"              # @faztudo goes to the project lead
name = "Faztudo"
repo_path = "~/code/faztudo"    # recorded with the project; runs still use the channel's repo_path
lead = "coder"                  # optional; always allowed in the project's channels
channels = ["faztudo-dev"]      # channel names, matched exactly
departments = ["engineering"]   # assigned at first start
specialists = ["claude"]        # single agents assigned at first start
```

- Handles share one namespace with personas and CLI names, so a department or
  project cannot be called `coder`. A bad name, an unknown lead or member, or
  an unknown department fails startup with a message that names the entry.
- `departments` and `specialists` on a project are the assignments the first
  time faztudo sees the project. After that the Director's changes in the app
  win, and editing the file does not undo them. Name, repository, lead and
  channels follow the file. A department or project removed from the file
  stays listed.
- In a channel listed under a project, only the project's lead, its assigned
  specialists, and the lead and members of its assigned departments run.
  Mentioning anyone else posts a notice with an "Assign" button, which only the
  Director can use. Channels that no project lists behave as before.
- `@<department>` and `@<project>` start that group's lead. A project with no
  `lead` answers with a notice instead.

### Chief of Staff and delegation

One persona can be the Chief of Staff:

```toml
[[persona]]
handle = "chief"
display_name = "Chief of Staff"
description = "Reads requests nobody is addressed in and hands them to the owner."
lanes = ["claude/opus", "codex/default"]
mode = "read"
chief_of_staff = true
channels = ["general"]          # channel names that opt in
```

- In a channel listed under `channels`, a message from a person that names no
  one (no `@mention`, no `/` command, not a thread reply) goes to the Chief
  of Staff. Direct channels never do. In a project's channel the Chief of
  Staff must be assigned to the project like any agent.
- Only one persona can have `chief_of_staff = true`, and `channels` only
  applies to it.
- The Chief of Staff and every department lead get a short guide in their
  prompt, with the agents they can hand work to and what each is for (the
  persona's `role` and `description`), and the `delegate` tool of faztudo's MCP
  server. They need a lane on a CLI with MCP support (`claude` or `codex`).
- `delegate` is checked on the server. The Chief of Staff can hand work to any
  other agent; a department lead only to the members of its departments; nobody
  else can delegate. Delegation is two levels deep at most: the Chief of Staff
  to a lead, and the lead to its specialists. Every handoff is a message in a
  thread under the request, plus a `handoff.created` event.
- One request can start `runs.request_max_runs` delegated runs. Of those,
  `runs.request_max_premium_runs` may go to agents whose first lane has
  `cost_class = "premium"`. Over a limit, faztudo asks the Director
  with a choice card in the channel and refuses further handoffs until they
  answer. "A" allows another round of the same size, anything else stops the
  request. Committed counts survive a restart; open cards and approved extra
  rounds do not.
- A delegated agent posts its result in the same thread. After the
  delegating run and all its pieces finish, faztudo starts one read-only
  follow-up for the delegating agent to combine their answers. A refused
  piece is included with its reason, and a piece whose run never started is
  reported as not started. No follow-up starts when every piece was refused
  (the agent already saw that), when a failed delegating run was retried on
  another lane (the retry answers), or for work handed out before this
  version. The digest that starts the follow-up is kept out of later runs'
  context. Set `runs.collect_delegations = false` to turn this off.

### Routines

A routine is a prompt that runs by itself, as a persona in a channel.

```toml
[[routine]]
handle = "daily-debrief"
name = "Daily debrief"
persona = "chief"
channel = "general"
schedule = "0 18 * * 1-5"   # five-field cron, in [routines] timezone
template = "debrief"        # adds the facts of the last day to the prompt
enabled = false             # starts switched off; the default is on

[[routine]]
handle = "welcome"
persona = "coder"
channel = "general"
trigger = "message"         # runs when a person posts in the channel
prompt = "Say hello to anyone new."

[[routine]]
handle = "failed-ci"
persona = "coder"
channel = "engineering"
trigger = "ci_failed"      # also issue_opened or pr_opened
prompt = "Investigate the GitHub event and report what needs attention."
```

- Set exactly one of `schedule` and `trigger`. A schedule has five fields
  (minute, hour, day of month, month, day of week) with `*`, lists, ranges,
  steps (`*/15`) and month and weekday names, or one of `@hourly`, `@daily`,
  `@weekly`, `@monthly`. It runs in the `[routines]` time zone. A run missed
  while faztudo was off is not made up.
- A trigger routine starts once for each new message a person posts in the
  channel as a top-level message. Messages from agents, routines and handoffs,
  and thread replies, never trigger anything.
- GitHub triggers `ci_failed`, `issue_opened` and `pr_opened` poll with the
  Director's signed-in `gh` CLI. The channel or its project needs a `repo_path`
  that is a git checkout with a GitHub origin. There is no webhook or stored
  GitHub token. The first successful poll establishes a cursor and runs nothing;
  later polls consider new items. The cursor is kept in the event log across
  restarts. If `gh` is missing or unauthenticated, the routine records a skipped
  result. At most five items run per routine per poll; extra items get a notice.
  Titles, authors, branches and URLs are passed as labeled, untrusted data;
  issue and pull request bodies are not sent to the agent.
- The routine posts its prompt in the channel as the Director, marked with the
  routine's handle, and the persona answers as for any message.
- `template = "debrief"` gives the agent facts that faztudo collects from its own
  records: runs finished, merged, failed, approvals waiting and lane health in
  the last 24 hours. The facts go into the prompt only. With a template the
  `prompt` may be empty.
- A routine does not run when its lane is exhausted, unavailable or in
  conserve, when its agent is not assigned to the channel's project, when its
  channel does not exist, or after `routines.max_per_day` runs that day. The
  reason is kept as its last result with the status "skipped".
- `enabled` in the file is the starting state. Afterwards the Director switches
  routines on and off in the app, and a restart keeps that. The prompt, schedule
  and persona follow the file. A routine removed from the file stays listed.
- Routines made in the app with Repeat this are not in the file. They are
  stored in the database and run on the same rules. See
  [organization](organization.md#routines).

### Templates

`faztudo init --template solo|team|empty` writes `lanes.toml` for you when it
holds nothing but comments, and refuses to touch it otherwise. The templates
are plain TOML files in `internal/templates/`:

| template | personas |
| :--- | :--- |
| `solo` | Chief of Staff (for `#general`), coder, reviewer |
| `team` | an Engineering department led by the architect, with architect, coder, reviewer and tester, plus a writer |
| `empty` | nothing, only comments |

Both ship a switched-off daily debrief. They declare a `claude/default` and a
`codex/default` lane; remove the ones you do not use.

Supported `cli` values: `claude`, `codex`, `grok`, `kimi`, `agy`,
`opencode`. Kimi, Antigravity and OpenCode have no read-only mode. A read
run passes over those lanes in its persona's chain, with a notice, and waits
for a busy lane that can run read-only rather than failing; a read persona
whose chain has no such lane cannot run. OpenCode's print mode produced no answer
in testing (opencode 1.16.2); treat that lane as experimental.

`conserve_at` is a per-lane percentage from 1 to 100. It defaults to 80.
Fresh measured usage below the threshold is available; usage at or above it
is conserve, and 100 percent is exhausted. Measurements are fresh for less
than 15 minutes. Missing or older percentages keep health unknown. Claude
and Grok log token totals without a quota percentage (Grok's per-session
ledgers under `~/.grok/sessions`), so the Lanes page shows their tokens in
the last 5 hours and today, and their health stays unknown unless
`plan_limit_tokens` sets a manual limit. That produces a percentage
estimate from local token totals.

Conserve lanes are a last resort. When a persona's chain holds a lane that
is available or unknown, it is used first even if a conserve lane comes
earlier in the list. A conserve lane runs only when no other lane in the chain
is usable, and the channel gets a notice saying so. A lane that is merely busy
counts as usable, so the run waits for it.

`runs_today` on a lane counts runs started on it since local midnight.
`tokens_last_hour` is filled for Claude and Grok lanes from the local
session logs.

Lane prices are optional and apply only where the local CLI logs input,
output and cache token counts. For example, add these illustrative prices
to a `[[lane]]` entry in `lanes.toml` (replace them with your own rates):

```toml
usd_per_million_input = 2.00
usd_per_million_output = 8.00
usd_per_million_cached = 0.50
```

The run card and Lanes page show a cost only for runs with a known token-kind
split and configured prices. Cost is an estimate, never billing. The Lanes
page shows how many of today's runs were measured and priced, so a partial
sum is clear. Cache writes use the input rate because there is no separate
cache-write setting. Usage history keeps each reading
for the history endpoint; the page draws 24-hour and 7-day trends.

The summary lane produces a rolling channel summary after `summary_every`
new root messages. Quiet channels are checked once a minute. The prompt
includes that summary and recent messages. A human can regenerate a summary
through the API.
When their rough size passes 65% of `context_limit_tokens`, it drops the
oldest recent messages. The estimate is four bytes per token, not a model
tokenizer. If summary generation fails, the previous summary stays in use.

`allowed_tools` is an optional list on a `claude` lane, passed to Claude as
`--allowedTools`. These tools run without asking, which matters because
Claude's print mode refuses every shell command that is not listed.

```toml
[[lane]]
id = "claude/sonnet"
cli = "claude"
model = "sonnet"
capacity = 1
allowed_tools = ["Bash(make test:*)", "Bash(go test:*)"]
```

Unset, a Claude write run may use `Bash(go test:*)`, `Bash(go vet:*)`,
`Bash(gofmt:*)`, `Bash(npm test:*)`, `Bash(npm run:*)`,
`Bash(npx vitest:*)`, `Bash(git status:*)`, `Bash(git diff:*)` and
`Bash(gh issue view:*)`. Setting the field replaces that list, and
`allowed_tools = []` allows none. Read runs have no default list. Whenever
faztudo passes its MCP endpoint, every Claude run, read or write, also allows
the ten faztudo tools (`mcp__faztudo__post_message`, `ask_human`,
`request_approval`, `read_context`, `list_members`, `delegate`,
`read_thread`, `search_messages`, `list_handoffs`, `suggest`); that is not
configurable. The server only offers `suggest` to runs started by a scout
routine (see [organization](organization.md#the-scout)).

Claude read runs do not use plan mode, which makes the model write a plan
file under `~/.claude/plans` and answer with the plan instead of calling
`delegate`. They use the default permission mode with `Read`, `Grep`,
`Glob` and `LS` allowed (or the lane's `allowed_tools`), the faztudo tools,
and `Write`, `Edit`, `MultiEdit`, `NotebookEdit` and `Bash` denied.
`claude -p` refuses any tool that is not allowed, so the run stays
read-only.

The last three only read. `read_thread` returns a thread (up to 100
messages, oldest first), `search_messages` finds message text (up to 30
hits, newest first), and `list_handoffs` shows the work handed out for the
run's request, with the state and answer of each run it started. They read
the run's own channel and, when it belongs to a project, the project's other
channels; a private or direct channel only if the agent is a member. Other
projects, direct messages the agent is not in, and (for search) archived
projects are never read. One call returns at most about 30 KB. `delegate`
also takes an optional `done_when`, added to the task as a last line.
Other CLIs ignore the field.

When `lanes.toml` configures any lane for a CLI, the detected-only
`<cli>/default` lane is no longer listed or used.

Every detected CLI also gets a plain persona with its own name (`@claude`,
`@codex`, ...) bound to its default lane.

Switching:

- In a message: `@coder /lane claude/opus fix the failing test`. The
  override applies to that persona for that message only and is removed from
  the prompt. A short name that matches the CLI or model of exactly one of
  the persona's lanes works too: `/lane codex` means `codex/default`. A short
  name that matches two lanes, an unknown lane, or one outside the persona's
  list gets a notice and no run.
- For a channel: `/lane coder claude/opus` in that channel makes that lane
  the persona's preferred lane there, until `/lane coder default` clears it.
  The lane must be in the persona's list. If the preferred lane is exhausted
  or unavailable, the normal order applies. Channel settings list the
  preferences, and `PATCH /api/v1/channels/{id}` accepts `lane_overrides`.
  The command starts no agent.
- Automatically: when a lane becomes exhausted or unavailable, new runs take
  the next healthy lane in the persona's list and the channel gets a notice.

Login and plan errors:

- Each adapter reads the CLI's error lines. A login or plan failure (HTTP
  401 or 403, `auth_error`, "not logged in", "please log in", "upgrade your
  plan", "subscription") marks the lane unavailable, with that line as the
  reason, on the Lanes page and in `/status`. A monthly or plan quota
  message marks it exhausted until the reset time. When the message names
  only its window ("your 5-hour usage limit", a daily or weekly limit), the
  window's length is used; when it names nothing, the lane is tried again
  after an hour. Timeouts and 5xx errors stay transient and are retried on the same
  lane. A failed task stays a failed task.
- The run that hit the error is retried once on the next healthy lane in the
  persona's list, as a new run whose `retry_of` is the failed run. The
  channel gets a notice naming both lanes and the reason, and the failed
  attempt posts no reply of its own.
- A lane chosen in the message (`@coder /lane ...`) does not fall back. The
  run fails and the notice says why. If that lane is already out of quota,
  no run starts: the notice names the lane and its reset time when known.
- An unavailable lane stays out of use until you probe it
  (`POST /api/v1/lanes/{id}/probe`, or the probe button on the Lanes page)
  or a run on it succeeds. The next failed run marks it again.
- A provider safety or content refusal fails only that request. The channel
  gets a refusal notice; the lane remains healthy. Exhaustion requires quota
  or limit wording, or a rate limit with a reset time.
- A human health override clears the previous failure and reset signal before
  the next request is routed. A human probe clears a stale exhausted signal
  only when a fresh reading is below the conserve threshold.

## Signal bridge

Signal is off until `enabled = true` is set in `[bridges.signal]`. Install
signal-cli and Java yourself, run `faztudo bridge signal link`, then configure
the linked account, allowed senders, and conversation bindings.
`faztudo doctor` checks for both commands and the linked account files.
Signal state lives under
`$XDG_DATA_HOME/faztudo/bridges/signal` (or
`~/.local/share/faztudo/bridges/signal` when XDG_DATA_HOME is unset).

```toml
[bridges.signal]
enabled = true
account = "+15551234567"
signal_cli = "signal-cli"
allow = ["+15551234567"]
approvals = false
alerts = "self"

[bridges.signal.bind]
self = "general"
```

Bind keys are `self`, `group:<Signal group ID>`, or `direct:<sender ID>`.
Values are existing faztudo channel names or IDs. The configured mirror needs
no per-message approval. Agent requests to send outward still need approval.
Signal approval replies are not active yet; step 3 will add keep and discard.

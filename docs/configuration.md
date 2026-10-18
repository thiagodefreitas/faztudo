# Configuration

faztudo follows the XDG directory layout:

| path | holds |
| :--- | :--- |
| `~/.config/faztudo/config.toml` | server settings |
| `~/.config/faztudo/lanes.toml` | lanes and personas |
| `~/.config/faztudo/secrets` | secrets when no keyring is available (mode 0600) |
| `~/.local/share/faztudo/faztudo.db` | the event log and projections |
| `~/.local/share/faztudo/worktrees/` | git worktrees for write runs |
| `~/.local/share/faztudo/runs/` | raw run output |
| `~/.local/share/faztudo/tls/` | local CA and LAN server certificates (mode 0700, keys 0600) |

`faztudo init` writes commented starting versions of both files.

## config.toml

```toml
[server]
listen = "127.0.0.1:7457"
open_browser = true

[lan]
enabled = false
listen = "0.0.0.0:7458"
ca_listen = "0.0.0.0:7459"

[runs]
default_timeout = "30m"
context_messages = 40       # recent messages sent to an agent
```

`allowed_hosts` (under `[server]`) lists extra host names accepted from a
reverse proxy running on this machine, for example
`allowed_hosts = ["mypc.tailnet-name.ts.net"]` with `tailscale serve`.
Requests must still arrive from 127.0.0.1; the proxy decides who may
connect. faztudo has no login of its own until LAN mode, so only use this
with a proxy that already restricts access to your own devices.

`faztudo serve` opens the URL with `xdg-open` after binding when
`open_browser` is true, stdout is a terminal, and `DISPLAY` or
`WAYLAND_DISPLAY` is set. Use `faztudo serve --no-open` to skip this.
When `[lan] enabled = true`, `faztudo serve` also binds the HTTPS LAN
listener on `lan.listen` (default `0.0.0.0:7458`) and the plain-HTTP CA
helper listener on `lan.ca_listen` (default `0.0.0.0:7459`). Run
`faztudo passwd` before starting LAN mode for the first time.

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
# plan_limit_tokens = 1000000 # optional manual limit for token-based usage (claude, grok)

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

Supported `cli` values: `claude`, `codex`, `grok`, `kimi`, `agy`,
`opencode`. Kimi and Antigravity have no read-only mode, so personas that
use them must be `mode = "write"`. OpenCode's print mode produced no answer
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
`tokens_last_hour` is filled for Claude lanes from the local session logs.

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
the five faztudo tools (`mcp__faztudo__post_message`, `ask_human`,
`request_approval`, `read_context`, `list_members`); that is not configurable.
Other CLIs ignore the field.

When `lanes.toml` configures any lane for a CLI, the detected-only
`<cli>/default` lane is no longer listed or used.

Every detected CLI also gets a plain persona with its own name (`@claude`,
`@codex`, ...) bound to its default lane.

Switching:

- In a message: `@coder /lane claude/opus fix the failing test`. The
  override applies to that persona for that message only and is removed from
  the prompt. An unknown lane, or one outside the persona's list, gets a
  notice and no run.
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
  message marks it exhausted, until the reset time when the message gives
  one. Timeouts and 5xx errors stay transient and are retried on the same
  lane. A failed task stays a failed task.
- The run that hit the error is retried once on the next healthy lane in the
  persona's list, as a new run whose `retry_of` is the failed run. The
  channel gets a notice naming both lanes and the reason, and the failed
  attempt posts no reply of its own.
- A lane chosen in the message (`@coder /lane ...`) does not fall back. The
  run fails and the notice says why.
- An unavailable lane stays out of use until you probe it
  (`POST /api/v1/lanes/{id}/probe`, or the probe button on the Lanes page)
  or a run on it succeeds. The next failed run marks it again.

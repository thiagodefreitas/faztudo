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

`faztudo init` writes commented starting versions of both files.

## config.toml

```toml
[server]
listen = "127.0.0.1:7457"   # LAN mode: "0.0.0.0:7457" plus [lan] below
open_browser = true

[lan]
enabled = false
# tls and pairing settings arrive in M2

[runs]
default_timeout = "30m"
context_messages = 40       # recent messages sent to an agent
```

`faztudo serve` opens the URL with `xdg-open` after binding when
`open_browser` is true, stdout is a terminal, and `DISPLAY` or
`WAYLAND_DISPLAY` is set. Use `faztudo serve --no-open` to skip this.

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
# plan_limit_tokens = 1000000 # optional manual limit for Claude's token-based daily usage

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
logs token totals without a quota percentage, so its health stays unknown
unless `plan_limit_tokens` sets a manual daily plan limit. This produces a
percentage estimate from local token totals.

Every detected CLI also gets a plain persona with its own name (`@claude`,
`@codex`, ...) bound to its default lane.

Switching:

- In a message: `@coder /lane claude/opus fix the failing test`.
- For a channel: `/lane coder claude/opus` in that channel.
- Automatically: when a lane becomes exhausted or unavailable, new runs take
  the next healthy lane in the persona's list and the channel gets a notice.

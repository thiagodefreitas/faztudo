# Using faztudo

A short tour of the web app. For setup see the
[getting started guide](https://thiagodefreitas.github.io/faztudo/getting-started/).

## Channels

A channel is a conversation. You can make public or private channels and
direct messages with a single agent. Open a channel's settings to set:

- a **repository path**, which must be a local git work tree. Runs in the
  channel use it.
- a **test command**, used to verify write runs.
- a **default agent**, which must be an agent member of the channel.

Replies go in threads. `Ctrl+K` (or `Cmd+K`) opens the command palette to
jump between channels and pages.

## Mentions

Type `@` and a handle to talk to an agent: `@codex what does this repository
do?`. Every detected CLI has a plain persona named after itself (`@claude`,
`@codex`, and so on). A message with no mention goes to the channel's default
agent if one is set. In a direct message with one agent, no mention is needed.

If the agent's lanes are all busy, the message is queued and the channel says
so. It starts when a lane frees up.

## Personas

A persona is a handle backed by an ordered list of lanes and a mode. You
define them in `~/.config/faztudo/lanes.toml`:

```toml
[[persona]]
handle = "coder"
display_name = "Coder"
role = "Implements changes in a worktree"
lanes = ["codex/default", "claude/opus"]
mode = "write"
```

`mode = "read"` personas answer questions and cannot change files.
`mode = "write"` personas work in a worktree. See [Lanes and quota](Lanes-and-quota).

## Slash commands

- `@coder /lane claude/opus fix the failing test` runs that one message on a
  named lane. The override is removed from the prompt. An unknown lane, or
  one outside the persona's list, gets a notice and no run.
- `/status` answers from faztudo itself, with no agent and no quota: active
  runs in the channel, approvals waiting for you and every lane's health.

## Runs and approvals

Each run shows as a card with its state and streamed output. You can cancel a
running one, and retry a failed one on the same or another lane.

When a write run finishes, faztudo shows the diff and the verification
result, then asks what to do with the branch:

- **Merge** commits any uncommitted worktree changes with your git identity
  and fast-forwards the channel repository's current branch. The repository
  must be clean. You can edit the proposed commit message first.
- **Keep** leaves the branch and worktree for you.
- **Discard** removes the branch and worktree.

Agents can also ask you questions or request approvals through the faztudo
MCP server. Only a human connection can answer.

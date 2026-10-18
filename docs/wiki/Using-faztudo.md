# Using faztudo

A short tour of the web app. For setup see the
[getting started guide](https://thiagodefreitas.github.io/faztudo/getting-started/).

## Channels

A channel is a conversation. You can make public or private channels and
direct messages with a single agent. Open a channel's settings to set:

- a **repository path**, which must be a local git work tree. Runs in the
  channel use it. The channel header shows only the repository folder name,
  with the full path on hover.
- a **test command**, used to verify write runs.
- a **default agent**, which must be an agent member of the channel.

Consecutive messages from the same author are grouped under one avatar and
header, and agent answers render headings, lists, tables and code blocks with
a copy button. Each agent is listed once in the sidebar. Replies go in
threads. `Ctrl+K` (or `Cmd+K`) opens the command palette to jump between
channels and pages.
On a phone the home screen is an inbox: pinned agents first, then every
conversation with its last message and unread count. When an agent asks
with lettered options (a choice card), tap an option or press its letter;
the answer goes back to the agent as a thread reply. Runs of messages
between agents collapse into one line you can expand.

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

## Avatars and states

Each agent CLI (`claude`, `codex`, `agy`, `kimi`, `opencode`, `grok`) has its
own small character on a colored tile, with no vendor logos. A persona uses
the character and color of its first lane's CLI and adds a role badge in the
lower-right corner (`</>` for coder, magnifier for reviewer, compass for
architect, quill for writer, dot for any other persona). Humans appear as a
circle with their initials.

A ring around an agent avatar shows its live state (animations pause when
`prefers-reduced-motion` is on):

| state | look | meaning |
| :--- | :--- | :--- |
| working | moving arc in the agent's color; the character bobs | a run is active on this agent |
| waiting | dashed amber ring | waiting for your approval or answer |
| failed | solid red ring | the latest run failed |
| off | dimmed and grayscale | offline or unavailable |

## Office

Open **Office** in the sidebar to see every member at a desk, with the
Director at the front of the room. Each desk shows whether the member is
working, queued, waiting for approval, failed or out of quota. Click any desk
to open its detail panel with its lane, quota health and current or last run,
jump to a pending approval in its channel, or start a direct message.
Personas and agent CLIs sit in separate pods, with the Director in front.

The 3D view (the 3D toggle on the Office page) shows the same room with
each agent as a character built from its avatar, acting out its state.

![The 2D office](https://raw.githubusercontent.com/thiagodefreitas/faztudo/main/docs/images/office-2d.png)

![The 3D office](https://raw.githubusercontent.com/thiagodefreitas/faztudo/main/docs/images/office-3d.png)

Each project also has a home page with what needs you, active runs,
channels, team, recent merges and routines:

![A project home](https://raw.githubusercontent.com/thiagodefreitas/faztudo/main/docs/images/project-home.png)

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

# Architecture

This page describes how faztudo is put together. Decisions behind it are in
[the decision records](adr/).

## Overview

```
  browser / PWA / desktop app --HTTPS + WebSocket--+
  bridges: Signal, Discord, ... (own processes) ---+
  agents calling back over MCP --------------------+
                                                   v
                           +------------------------------------------+
                           |  faztudo daemon (one Go binary)          |
                           |                                          |
                           |  api ----> event log (SQLite, append)    |
                           |              |                           |
                           |              v                           |
                           |         projections (channels, runs,     |
                           |         lanes, unread, presence)         |
                           |              |                           |
                           |  router: mentions, channel rules         |
                           |              |                           |
                           |  runner: capacity, worktrees, timeouts   |
                           |              |                           |
                           |  adapters: claude codex grok kimi agy    |
                           |            opencode, custom             |
                           +------------------------------------------+
                                          |
                                          v
                         agent CLI processes (own process group,
                         stdin closed, stripped environment)
```

## The event log

Everything that happens is an event: a message posted, a run started, a line
of agent output, an approval requested or answered, a lane changing health, a
bridge delivering a message. Events are appended to one SQLite table and
never edited. Each event has:

| field | meaning |
| :--- | :--- |
| `seq` | integer, strictly increasing; the delivery cursor clients resume from |
| `id` | ULID, a stable public id |
| `version` | payload schema version for this `type` |
| `type` | for example `message.posted`, `run.output`, `approval.resolved` |
| `actor` | who caused it: `human:<id>`, `agent:<id>`, `bridge:<id>`, `system`. Set by the server from the connection, never from the payload. |
| `channel_id` | where it belongs, if anywhere |
| `idempotency_key` | optional; a repeated key returns the first event instead of adding a second |
| `payload` | JSON, versioned by `type` |
| `ts` | server time |

Projections are tables built from the log, such as the message list of a
channel or the current state of a run. They are updated in the same SQLite
transaction as the append, so a crash never leaves the log and a projection
disagreeing. They can also be rebuilt from scratch at any time by replaying
the log in `seq` order. The web UI subscribes to the event stream over a WebSocket and
keeps its own view up to date. The 2D and 3D office views read the same
stream, so they show exactly what the chat shows.

## Data model

- **workspace**: the top-level container. One per install for now.
- **member**: a human or an agent. Agents are members with a persona (name,
  avatar, role prompt) and a lane chain.
- **channel**: public, private or direct. A `kind` tag (team, department,
  project, agent) is for grouping in the UI and does not change behavior.
- **thread**: replies to one message.
- **run**: one agent invocation, with its mode (read-only or write), lane,
  worktree, state, output and verification result.
- **approval**: a request from an agent or the system that only a human can
  resolve.
- **lane**: one agent CLI plus account plus model route, with capacity, quota
  windows and health.
- **bridge binding**: maps an outside conversation (a Signal group, a
  Discord channel) to a faztudo channel.

## Runs

1. A message mentions an agent persona, or a channel rule fires.
2. The router picks a lane from the persona's chain: the first lane that is
   healthy and has free capacity. If it skipped a lane, it posts a notice
   saying which lane it used and why.
3. The runner builds a bounded context: pinned items, the channel summary and
   the most recent messages. The size estimate counts the standing
   instructions, tool definitions and a reserve for the answer, and stays
   under 0.65 of the model's limit. A summary is a convenience for the
   agent, never a source of truth; the log is.
4. For a write run, the runner creates a git worktree under
   `~/.local/share/faztudo/worktrees/` from the channel's repository.
5. The adapter turns the request into the exact command line for that CLI.
   The process starts with stdin closed, in its own process group, with
   secret variables removed from its environment, and with a timeout.
6. Output streams into the channel as `run.output` events.
7. When the process exits, the runner records the exit code and classifies
   any failure as transient (retry later), semantic (quota exhausted, test
   failed) or unknown (never retried automatically).
8. Verification runs: the diff exists, optional test command passes. Only a
   verified run is shown as done.

Run states: `queued`, `running`, `verifying`, `done`, `failed`, `cancelled`,
`waiting_approval`. The result of verification is shown in the channel, not
only in a log.

Every run records the process id, the process group and the process start
time. A restarted daemon checks each run that was `running` against `/proc`:
if the same process (same id and same start time) is alive, it reattaches;
if not, it kills whatever is left of the group and marks the run failed with
the reason. It never starts a second copy while the first may still be
working.

## Lanes

A lane is one agent CLI, one account and one model route, for example
`claude/opus` or `codex/default`. Each lane tracks:

- **capacity**: how many runs may use it at once;
- **windows**: usage per quota window (five hours, week, month) with the
  reset time;
- **health**: `available`, `conserve`, `exhausted`, `unavailable` or
  `unknown`;
- **source and age** of every number: parsed from the CLI's own local logs,
  measured by a probe, inferred from an error, or typed in by hand.

Personas such as `@coder` or `@reviewer` map to an ordered list of lanes.
When a lane becomes exhausted, new runs go to the next lane, and the channel
is told. A run that already started is never moved silently.

## faztudo as an MCP server

Agents that support MCP get a small set of faztudo tools: post a message,
ask a human a question, request an approval, read recent channel context,
list members. This is how agents work together in a channel instead of only
answering once. The approval tool can only create requests; resolving one
requires a human connection.

## Bridges

A bridge is a separate process that connects an outside messaging system to
faztudo. It talks to the daemon over a small JSON-RPC protocol on stdin and
stdout, so a bridge can be written in any language. Bridges keep no state of
their own and send an idempotency key with every delivery, so a repeated
delivery cannot create duplicate work. Signal comes first, through
`signal-cli` running as its own program.

## Security boundaries

- Listens on 127.0.0.1 by default. LAN mode adds TLS with a local certificate
  authority, a login (passkey or password) and per-device pairing by QR code.
- Secrets live in the system keyring or a 0600 file under
  `~/.config/faztudo`, never in the database or logs.
- Write runs happen in worktrees. Actions that go through faztudo, such as
  pushing a branch or sending to a bridge, need human approval.
- An agent CLI runs as your user. faztudo cannot stop it from doing
  something it is able to do on its own. The fence for that is each CLI's own
  sandbox and permission mode, which faztudo sets as strictly as the run
  allows, and an optional Linux sandbox (bubblewrap) for write runs.

## Repository layout

```
cmd/faztudo/         command line entry point and daemon
internal/            store, events, router, runner, adapters, mcp, auth, api, config, secrets
web/                 React web app
bridges/             one directory per bridge
desktop/             Tauri shell (later)
site/                documentation website
docs/                these documents
```

# API

The web app, the desktop app and bridges all use the same HTTP and WebSocket
API served by the daemon. This page is the contract. Version 1 lives under
`/api/v1`. Fields marked "later" are reserved and may be absent.

All bodies are JSON. Times are RFC 3339 strings in UTC. IDs are ULIDs, as
strings. Errors use one shape:

```json
{ "error": { "code": "not_found", "message": "channel not found" } }
```

Codes: `bad_request` (400), `unauthorized` (401), `forbidden` (403),
`not_found` (404), `conflict` (409), `rate_limited` (429), `internal` (500).

## Authentication

On 127.0.0.1 with LAN mode off, the single local user is signed in
automatically. In LAN mode, every request needs the session cookie set by
`POST /api/v1/auth/login` (later: passkeys and device pairing).

## Objects

```ts
type ID = string;           // ULID

interface Member {
  id: ID;
  kind: "human" | "agent";
  handle: string;           // unique, used for @mentions: "thiago", "coder", "codex"
  display_name: string;
  avatar?: string;          // URL or built-in avatar key
  agent?: {
    lanes: string[];        // ordered fallback chain of lane ids
    role?: string;          // short description shown in the UI
  };
  presence: "online" | "idle" | "busy" | "offline";
}

interface Channel {
  id: ID;
  name: string;             // "faztudo-dev", lowercase, dashes
  kind: "team" | "department" | "project" | "agent" | "direct";
  visibility: "public" | "private" | "direct";
  topic?: string;
  repo_path?: string;       // local git repo that write runs in this channel use
  member_ids: ID[];
  unread: number;
  last_event_id?: ID;
}

interface Message {
  id: ID;
  channel_id: ID;
  thread_id?: ID;           // id of the root message, when this is a reply
  author_id: ID;
  body: string;             // markdown
  mentions: ID[];
  run_id?: ID;              // set when the message is an agent run's output
  created_at: string;
  edited_at?: string;
  reply_count?: number;     // on thread roots
}

type RunState = "queued" | "running" | "waiting_approval" | "verifying"
              | "done" | "failed" | "cancelled";

interface Run {
  id: ID;
  channel_id: ID;
  trigger_message_id: ID;
  agent_id: ID;             // the persona member
  lane_id: string;          // the lane actually used
  mode: "read" | "write";
  state: RunState;
  worktree?: string;
  started_at?: string;
  ended_at?: string;
  exit_code?: number;
  failure_class?: "transient" | "semantic" | "unknown";
  failure_reason?: string;
  verification?: { ok: boolean; detail: string };
  diff_stat?: { files: number; insertions: number; deletions: number };
}

interface Approval {
  id: ID;
  run_id?: ID;
  channel_id: ID;
  requested_by: ID;         // member id, agent or system
  title: string;            // "Push branch fz/run-01J... to origin"
  detail: string;           // markdown, may contain a diff or command
  options: { key: string; label: string; style?: "primary" | "danger" }[];
  state: "pending" | "resolved" | "expired";
  resolution?: { option: string; by: ID; at: string; note?: string };
}

type LaneHealth = "available" | "conserve" | "exhausted" | "unavailable" | "unknown";

interface Lane {
  id: string;               // "claude/opus", "codex/default"
  cli: "claude" | "codex" | "grok" | "kimi" | "agy" | "opencode" | "custom";
  model?: string;
  cost_class: "premium" | "standard" | "cheap" | "local";
  capacity: number;
  running: number;
  health: LaneHealth;
  health_reason?: string;
  windows: {
    name: "5h" | "day" | "week" | "month";
    used_pct?: number;      // 0..100, absent when unknown
    resets_at?: string;
    source: "cli-log" | "probe" | "error" | "manual" | "unknown";
    measured_at?: string;
  }[];
  runs_today: number;
  tokens_last_hour?: number;
  last_error?: { class: string; message: string; at: string };
}
```

## Endpoints

| method | path | does |
| :--- | :--- | :--- |
| GET | `/api/v1/me` | the signed-in member |
| GET | `/api/v1/members` | all members, humans and agents |
| GET | `/api/v1/channels` | channels the caller can see |
| POST | `/api/v1/channels` | create `{name, kind, visibility, topic?, repo_path?, member_ids?}` |
| PATCH | `/api/v1/channels/{id}` | update name, topic, repo_path, members |
| GET | `/api/v1/channels/{id}/messages?before=&limit=` | page of messages, newest last; `limit` max 200 |
| GET | `/api/v1/messages/{id}/thread` | root plus replies |
| POST | `/api/v1/channels/{id}/messages` | post `{body, thread_id?, idempotency_key?}`; mentions are parsed server side |
| POST | `/api/v1/channels/{id}/read` | mark read up to `{event_id}` |
| GET | `/api/v1/runs?channel_id=&state=` | runs |
| GET | `/api/v1/runs/{id}` | one run |
| GET | `/api/v1/runs/{id}/output?after=` | raw output lines |
| GET | `/api/v1/runs/{id}/diff` | unified diff of a write run |
| POST | `/api/v1/runs/{id}/cancel` | cancel a run |
| POST | `/api/v1/runs/{id}/retry` | retry `{lane_id?}` on the same or another lane |
| GET | `/api/v1/approvals?state=pending` | approvals |
| POST | `/api/v1/approvals/{id}/resolve` | `{option, note?}`; humans only |
| GET | `/api/v1/lanes` | all lanes |
| PATCH | `/api/v1/lanes/{id}` | set `{capacity?, health_override?, manual_window?}` |
| POST | `/api/v1/lanes/{id}/probe` | refresh this lane's usage now |
| GET | `/api/v1/health` | `{ok, version}` without auth |

## Event stream

`GET /api/v1/stream` upgrades to a WebSocket. The client sends:

```json
{ "op": "subscribe", "after": "<last event id seen, optional>" }
```

The server first replays every event after that id, then streams new ones.
Every frame is one event:

```json
{
  "id": "01JABC...",
  "type": "message.posted",
  "actor": "agent:01JXYZ...",
  "channel_id": "01JCH...",
  "ts": "2026-10-18T09:15:02Z",
  "payload": { }
}
```

Event types in version 1:

| type | payload |
| :--- | :--- |
| `message.posted` | `Message` |
| `message.edited` | `{id, body, edited_at}` |
| `channel.created`, `channel.updated` | `Channel` |
| `member.updated` | `Member` |
| `presence.changed` | `{member_id, presence}` |
| `run.created`, `run.updated` | `Run` |
| `run.output` | `{run_id, seq, stream: "stdout" or "stderr", text}` |
| `approval.requested`, `approval.resolved` | `Approval` |
| `lane.updated` | `Lane` |
| `lane.switched` | `{run_id, from, to, reason}` |
| `notice` | `{level: "info" or "warn" or "error", text}` |

Clients keep the id of the last event they saw and pass it on reconnect, so
nothing is lost while a phone sleeps.

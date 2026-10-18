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

On `127.0.0.1` (`server.listen`), the single local user is signed in
automatically. With LAN mode on, a loopback request that carries a proxy
header (`X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Proto` or
`Forwarded`) is treated as a LAN request and needs a session. On the LAN HTTPS listener (`lan.listen`, default
`0.0.0.0:7458`), every API request (except `GET /api/v1/health`,
`GET /ca.crt`, `POST /api/v1/auth/login`, and `POST /api/v1/auth/pair`)
requires the `fz_session` cookie (`HttpOnly`, `Secure`, `SameSite=Strict`,
`Path=/`, 30-day sliding expiry) set by `POST /api/v1/auth/login` or
`POST /api/v1/auth/pair`.

On the LAN listener, every state-changing request (`POST`, `PATCH`, `DELETE`)
and every `GET /api/v1/stream` WebSocket upgrade must carry an `Origin`
header equal to `https://<Host>` (403 otherwise). `/mcp` is loopback-only.

## Objects

```ts
type ID = string;           // ULID

interface Device {
  id: ID;
  device_name: string;
  user_agent: string;
  created_at: string;
  last_seen_at: string;
  current?: boolean;
}

interface PairingTicket {
  token: string;            // 128-bit hex token, valid 5 minutes, single use
  url: string;              // https://<lan-ip>:7458/pair#<token>
  qr_svg: string;           // server-rendered SVG QR code
  ca_fingerprint: string;   // SHA-256 fingerprint of the local CA
  ca_http_url?: string;     // http://<lan-ip>:7459 helper URL
  expires_at: string;
}

interface Member {
  id: ID;
  kind: "human" | "agent";
  handle: string;           // unique, used for @mentions: "thiago", "coder", "codex"
  display_name: string;
  avatar?: string;          // URL or built-in avatar key
  agent?: {
    lanes: string[];        // ordered fallback chain of lane ids
    role?: string;          // short description shown in the UI
    mode?: "read" | "write"; // default mode for runs this agent starts
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
  test_command?: string;    // optional verification command run in the worktree
  default_agent_id?: ID;    // agent that answers human messages with no mention and no leading /
  member_ids: ID[];
  unread: number;
  last_seq?: number;
}

interface Message {
  id: ID;
  channel_id: ID;
  thread_id?: ID;           // id of the root message, when this is a reply
  author_id: ID;
  body: string;             // markdown
  mentions: ID[];
  options?: string[];       // 2 to 5 short answers an agent offers with ask_human
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
  base_commit?: string;     // commit the write run started from
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
  commit_message?: string;  // write runs: proposed Merge commit message
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
| POST | `/api/v1/auth/login` | verify `{password, device_name?}`, create session, set `fz_session` cookie; rate-limited to 5 failures per 15 minutes per remote address (429) |
| POST | `/api/v1/auth/logout` | delete the current session and clear `fz_session` |
| GET | `/api/v1/auth/devices` | list active device sessions (`Device[]`) |
| DELETE | `/api/v1/auth/devices/{id}` | revoke a device session and close its open WebSocket streams immediately |
| POST | `/api/v1/auth/pairings` | loopback only: create a 5-minute single-use pairing token (`PairingTicket`) with SVG QR code and CA fingerprint |
| POST | `/api/v1/auth/pair` | exchange `{token, device_name}` for a session cookie; burns the token on first use whether it succeeds or not |
| GET | `/api/v1/auth/ca` | `{ca_fingerprint, ca_http_url, lan_urls}` |
| GET | `/ca.crt` | download the local CA certificate in PEM format (also served on the port 7459 plain-HTTP CA helper) |
| GET | `/api/v1/me` | the signed-in member |
| GET | `/api/v1/members` | all members, humans and agents |
| GET | `/api/v1/channels` | channels the caller can see |
| POST | `/api/v1/channels` | create `{name, kind, visibility, topic?, repo_path?, member_ids?}` |
| PATCH | `/api/v1/channels/{id}` | update name, topic, repo_path, test_command, default_agent_id, members; a non-empty `repo_path` must be a git work tree and a non-empty `default_agent_id` must be an agent member of the channel (400 otherwise) |
| GET | `/api/v1/channels/{id}/messages?before=&limit=` | page of top-level messages (thread replies excluded), newest last; `limit` max 200 |
| GET | `/api/v1/messages/{id}/thread` | root plus replies |
| POST | `/api/v1/channels/{id}/messages` | post `{body, thread_id?, idempotency_key?}`; mentions are parsed server side; a message with no mention in a direct channel that has exactly one agent member triggers that agent; a reply to a reply attaches to the thread root |
| POST | `/api/v1/channels/{id}/read` | mark read up to `{seq}` (the channel's `last_seq`); `{event_id}` is also accepted |
| GET | `/api/v1/runs?channel_id=&state=` | runs |
| GET | `/api/v1/runs/{id}` | one run |
| GET | `/api/v1/runs/{id}/output?after=` | raw output lines |
| GET | `/api/v1/runs/{id}/diff` | unified diff of a write run |
| POST | `/api/v1/runs/{id}/cancel` | cancel a run |
| POST | `/api/v1/runs/{id}/retry` | retry `{lane_id?}` on the same or another lane |
| GET | `/api/v1/approvals?state=pending` | approvals |
| POST | `/api/v1/approvals/{id}/resolve` | `{option, note?, commit_message?}`; humans only. For a write run, `commit_message` replaces the approval's proposed `commit_message` as the Merge commit message |
| GET | `/api/v1/lanes` | all lanes |
| PATCH | `/api/v1/lanes/{id}` | set `{capacity?, health_override?, manual_window?}` |
| POST | `/api/v1/lanes/{id}/probe` | refresh this lane's usage now |
| GET | `/api/v1/health` | `{ok, version, api}` without auth on loopback; `{ok}` only on the LAN listener |

## Event stream

`GET /api/v1/stream` upgrades to a WebSocket. The client sends:

```json
{ "op": "subscribe", "after_seq": 1234 }
```

`after_seq` is the `seq` of the last event the client saw, or 0. The server
first replays every event after it in order, then streams new ones.
Every frame is one event:

```json
{
  "seq": 1235,
  "id": "01JABC...",
  "version": 1,
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

Clients keep the `seq` of the last event they saw and pass it on reconnect,
so nothing is lost while a phone sleeps. Events with the same `seq` are the
same event; clients ignore repeats.

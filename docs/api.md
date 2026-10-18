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

On `127.0.0.1` (`server.listen`), the single local user authenticates with
`Authorization: Bearer <token>` or the `fz_local` cookie. The 32-byte hex
token is stored in the data directory as `local-token` (mode 0600).
`faztudo open` visits `/auth/local#<token>`; that page sends the fragment in
JSON to `POST /api/v1/auth/local`, which sets the HttpOnly, SameSite=Strict,
Path=/ cookie for one year. The cookie contains an HMAC derived from the token,
not the token. `faztudo token --rotate` invalidates old cookies. Failed bearer
attempts are rate-limited. `GET /api/v1/health` and `/mcp` keep their own rules.
The local exchange accepts only loopback connections and the local Origin (or
no Origin for a CLI request). An unauthenticated local browser sees a short
page directing it to `faztudo open`, without app data.
With LAN mode on, a loopback request that carries a proxy
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
    description?: string;   // longer description, shown on the Organization page
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
  lane_overrides?: Record<string, string>; // persona handle -> preferred lane id, set with /lane <persona> <lane>
  member_ids: ID[];
  unread: number;
  last_seq?: number;
}
```

Channel commands: `/lane <persona> <lane>` pins the persona's lane in
this channel (a `channel.updated` event and a notice confirm it);
`/lane <persona> default` clears the pin. The persona may be written with a
leading `@`. The command starts no agent. A write run that changes nothing
ends `done` with a "No changes" notice and no approval.

```ts
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
  retry_of?: ID;            // the failed run this one retried on the next lane
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
    tokens?: number;        // tokens used in the window, for CLIs that log tokens but no quota (claude, grok)
    resets_at?: string;
    source: "cli-log" | "probe" | "error" | "manual" | "unknown";
    measured_at?: string;
  }[];
  runs_today: number;
  runs_date?: string;       // local day (YYYY-MM-DD) that runs_today counts
  tokens_last_hour?: number;
  cost_today_usd?: number;  // local token-price estimate, never billing
  alerted?: boolean;        // alert already sent for this health episode
  last_error?: { class: string; message: string; at: string };
}
```

```ts
// Departments and projects come from lanes.toml; the Director changes the
// assignments of a project through the API. handles are agent handles.
interface Department {
  handle: string;           // @engineering goes to its lead
  display_name: string;
  lead?: string;
  members: string[];
}

interface Project {
  handle: string;           // @launch goes to its lead
  name: string;
  repo_path?: string;
  lead?: string;            // always allowed in the project's channels
  channels: string[];       // channel names
  departments: string[];    // assigned departments (the lead and members may act)
  specialists: string[];    // assigned single agents
}

interface Org {
  director_id: ID;
  departments: Department[];
  projects: Project[];
}

// A button on a notice. "assign" asks the Director to assign the specialist
// `agent` to the project `project`: POST /api/v1/projects/{project}/assignments
// with {kind: "specialist", handle: agent}.
interface NoticeAction {
  kind: "assign";
  label: string;
  project: string;
  agent: string;
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
| GET | `/api/v1/org` | `Org`: the Director's member id, the departments and the projects with their assignments |
| POST | `/api/v1/projects/{project}/assignments` | assign `{kind: "department" or "specialist", handle}` to the project with that handle; humans only (403 for an agent), 400 for an unknown handle, 404 for an unknown project; returns the `Project`; repeating it changes nothing |
| DELETE | `/api/v1/projects/{project}/assignments/{kind}/{handle}` | remove an assignment; humans only; returns the `Project` |
| GET | `/api/v1/channels` | channels the caller can see |
| POST | `/api/v1/channels` | create `{name, kind?, visibility?, topic?, repo_path?, member_ids?}`; kind defaults to `team`, visibility to `public` |
| PATCH | `/api/v1/channels/{id}` | update name, topic, repo_path, test_command, default_agent_id, lane_overrides, members; a non-empty `repo_path` must be a git work tree, a non-empty `default_agent_id` must be an agent member of the channel, and every `lane_overrides` entry must name an agent and one of its lanes (400 otherwise); `lane_overrides` replaces the whole map |
| GET | `/api/v1/channels/{id}/messages?before=&limit=` | page of top-level messages (thread replies excluded), newest last; `limit` max 200 |
| GET | `/api/v1/messages/{id}/thread` | root plus replies |
| POST | `/api/v1/channels/{id}/messages` | post `{body, thread_id?, idempotency_key?}`; mentions are parsed server side; a message with no mention in a direct channel that has exactly one agent member triggers that agent; `@<department>` triggers that department's lead and `@<project>` the project's lead; in a channel that belongs to a project only agents assigned to it run, and each other mentioned agent gets a `notice` with an `assign` action; a reply to a reply attaches to the thread root |
| POST | `/api/v1/channels/{id}/read` | mark read up to `{seq}` (the channel's `last_seq`); `{event_id}` is also accepted |
| GET | `/api/v1/runs?channel_id=&state=` | runs |
| GET | `/api/v1/runs/{id}` | one run |
| GET | `/api/v1/runs/{id}/output?after=` | raw output lines |
| GET | `/api/v1/runs/{id}/diff` | unified diff of a write run |
| POST | `/api/v1/runs/{id}/cancel` | cancel a run |
| POST | `/api/v1/runs/{id}/retry` | retry `{lane_id?}` on the same or another lane |
| GET | `/api/v1/approvals?state=pending` | approvals |
| POST | `/api/v1/approvals/{id}/resolve` | `{option, note?, commit_message?}`; humans only. For a write run, `commit_message` replaces the approval's proposed `commit_message` as the Merge commit message |
| GET | `/api/v1/lanes` | configured lanes (a detected-only default is hidden once lanes.toml configures that CLI) |
| GET | `/api/v1/lanes/{id}/history?window=&since=` | usage readings for a lane; `window` is optional (`5h`, `day`, `week`, `month`), `since` is RFC3339 and defaults to 7 days ago (at most 31 days ago) |
| GET | `/api/v1/lanes/channel-summary/{channel_id}` | latest rolling summary, or an empty summary object before the first one |
| POST | `/api/v1/lanes/channel-summary/{channel_id}/regenerate` | human-only; regenerate the summary from stored root messages |
| PATCH | `/api/v1/lanes/{id}` | set `{capacity?, health_override?, manual_window?}` (capacity must be at least 1; health_override records the reason as a manual override) |
| POST | `/api/v1/lanes/{id}/probe` | refresh this lane's usage now |
| GET | `/api/v1/health` | `{ok, version, api}` without auth on loopback; `{ok}` only on the LAN listener |

Each history item is `{lane_id, window, read_at}`. `window` has the same
shape as an entry in `Lane.windows`; `read_at` is when the daemon read it.
`lane.usage_read` and `lane.alert` are emitted in the event stream. A lane
alert contains `{lane_id, health, reason}` and is emitted once per alert
episode; recovery re-arms it. A channel summary is stored as a
`channel.summarized` event with `{channel_id, lane_id, text,
through_message_id, updated_at}`.

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
| `department.updated` | `Department` |
| `project.updated` | `Project` (sent when the Director changes an assignment) |
| `notice` | `{level: "info" or "warn" or "error", text, action?: NoticeAction}` |

Clients keep the `seq` of the last event they saw and pass it on reconnect,
so nothing is lost while a phone sleeps. Events with the same `seq` are the
same event; clients ignore repeats.

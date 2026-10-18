# API

The web app and phone app use the HTTP and WebSocket API served by the daemon.
Bridges use the separate JSON-RPC stdio protocol in
[bridge-protocol.md](bridge-protocol.md). This page is the HTTP contract. Version 1 lives under
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
    chief_of_staff?: boolean; // gets messages nobody is addressed in, in channels that opted in
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

A message can select one run's lane with `@persona /lane <lane> <directive>`.
The message is saved even when the lane is unknown or outside that persona's
chain. In either case no run starts for that persona, and a channel notice
names the lanes it can use. A valid override runs only on the named lane.

`@persona x2 <directive>` compares two write runs. It uses the first two
healthy lanes in that persona's chain, skips conserve and exhausted lanes,
and starts nothing if fewer than two are available. The channel gets a notice
explaining why. Each candidate has its own worktree. The compare card offers
Merge A, Merge B, Discard both, and Combine after both candidates finish.
Merging one discards the other. Combine discards both candidates and starts a
third write run whose prompt includes both diffs; it does not merge anything.
Only a human message can start a compare; an `x2` posted by an agent (MCP
post or a delegated message) starts nothing and gets a notice. Combine
records `compare.decided` (with `combine_message_id`) before the third run
starts, and a repeated Combine starts the run only if none exists yet.

```ts
interface Message {
  id: ID;
  channel_id: ID;
  thread_id?: ID;           // id of the root message, when this is a reply
  author_id: ID;
  body: string;             // markdown
  mentions: ID[];
  options?: string[];       // 2 to 5 short answers an agent offers with ask_human
  attachments?: Attachment[]; // uploaded files
  run_id?: ID;              // set when the message is an agent run's output
  handoff?: Handoff;        // set when an agent handed work over with the delegate tool
  routine?: string;         // handle of the routine that posted this message
  task?: ID;                // id of the task whose start posted this message
  created_at: string;
  edited_at?: string;
  reply_count?: number;     // on thread roots
}

interface Handoff {
  request_id: ID;           // the message that started the chain
  from: string;             // agent handles
  to: string;
  depth: number;            // 1 for the first handoff, 2 for a lead splitting it
}

interface Routine {
  handle: string;
  name: string;
  prompt: string;
  persona: string;          // handle of the agent that runs it
  channel: string;          // channel name
  schedule?: string;        // five-field cron, in the configured time zone
  trigger?: "message";      // runs when a person posts in the channel
  template?: "debrief";
  enabled: boolean;
  next_run?: string;        // scheduled routines that are on
  last?: { at: string; status: "ok" | "failed" | "skipped"; detail?: string; run_id?: ID };
}

interface Task {
  id: ID;
  channel_id: ID;
  title: string;
  body?: string;            // the directive
  assignee: string;         // handle of the agent
  lane?: string;            // set when the task is pinned to a lane, as with /lane
  mode: "read" | "write";   // overrides the agent's own mode for this task
  scope: string[];          // paths or areas it may touch
  checks: string[];         // commands to run and report
  acceptance: string[];     // what done means
  status: "todo" | "running" | "review" | "done" | "failed" | "cancelled";
  order: number;            // sorts the Todo column
  message_id?: ID;          // the message that started it
  run_ids: ID[];            // runs for that message, oldest first, retries included
  approval_id?: ID;         // the approval of the newest run, when it has one
  created_by: ID;
  created_at: string;
  updated_at: string;
}

interface Attachment {
  id: string;               // SHA-256 of the content, 64 hex characters
  name: string;             // base name only, at most 120 bytes
  content_type: string;     // sniffed from the bytes, never taken from the upload
  size: number;
}

interface Pin {
  channel_id: ID;
  message_id: ID;
  pinned_by: ID;
  pinned_at: string;
  message: Message;
}

interface SearchHit {
  message: Message;         // may be a thread reply: open thread_id
  snippet: string;          // text with each match between U+0001 and U+0002
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
  // Set when the run ends, from the CLI's own local log. Absent means unknown.
  tokens?: { input: number; output: number; cache_read: number; cache_write: number };
  cost_usd?: number;        // estimate from the lane's configured prices, never billing
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
  archived: boolean;        // archived channels remain readable, but do not run agents
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

`Run.tokens` and `Run.cost_usd` are filled when a run ends, from the usage the CLI wrote to its own local log for that run: Claude's session JSONL, Codex's rollout file and Grok's `usage.json` turns. Other CLIs leave them absent, and so does a run whose session cannot be told apart from another run in the same directory at the same time. `cost_usd` also needs the lane's `usd_per_million_*` prices. It is an estimate, not billing, and unknown stays absent rather than zero.

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
| POST | `/api/v1/projects` | create `{handle, name?, repo_path?, lead?, channels?, departments?, specialists?}`; humans only (403 for an agent), 400 for a bad handle, an unknown lead, department or specialist, a channel another project lists or a `repo_path` that is not a git work tree, 409 when the handle exists; the name defaults to the handle; 201 with the `Project`, and a `project.updated` event; the project is stored like one from lanes.toml and survives a restart |
| PATCH | `/api/v1/projects/{project}` | change `{name?, repo_path?, lead?, channels?, archived?}` of a project; humans only (403 for an agent), 400 for an empty name, unknown lead, invalid or duplicate channel, or repository that is not a git work tree; assignments stay; returns the `Project` and emits `project.updated`. Archiving persists across restarts, leaves channels readable, and refuses new agent routing in those channels. A project also in lanes.toml takes its name, repository, lead and channels from the file again on the next start |
| POST | `/api/v1/projects/{project}/assignments` | assign `{kind: "department" or "specialist", handle}` to the project with that handle; humans only (403 for an agent), 400 for an unknown handle, 404 for an unknown project; returns the `Project`; repeating it changes nothing |
| DELETE | `/api/v1/projects/{project}/assignments/{kind}/{handle}` | remove an assignment; humans only; returns the `Project` |
| GET | `/api/v1/routines` | `Routine[]` with the time of the next run |
| PATCH | `/api/v1/routines/{handle}` | switch `{enabled}` on or off; humans only (403 for an agent), 404 for an unknown routine; returns the `Routine` |
| GET | `/api/v1/tasks?channel_id=&project=` | `Task[]` by board order; `project` is a project handle (404 if unknown) and keeps the tasks of its channels |
| POST | `/api/v1/tasks` | humans only. `{channel_id, title, assignee, body?, lane?, mode?, scope?, checks?, acceptance?, start?}` creates a task in Todo and returns it (201). With `start: true` it also starts it. 400 with the reason when the input is wrong or the assignee is not an agent |
| GET | `/api/v1/tasks/{id}` | `Task`, 404 if unknown |
| PATCH | `/api/v1/tasks/{id}` | humans only. Any of `title, body, assignee, lane, mode, scope, checks, acceptance, order`; only a task in Todo can change (400 otherwise) |
| POST | `/api/v1/tasks/{id}/start` | humans only. Posts the directive in the channel as a message that mentions the assignee, with `Message.task` set, and runs the agent. A failed task can be started again. 409 with the reason when it cannot run now (archived project, unknown lane, lane out of quota, write mode without `repo_path`, already started) and nothing is posted |
| POST | `/api/v1/tasks/{id}/cancel` | humans only. Drops a Todo task or stops a running one and its runs; 409 when it waits for an approval (decide that instead) or has ended |
| POST | `/api/v1/routines/{handle}/run` | start the routine now, on or off; humans only; 202 `{status: "started"}`, or 409 with the reason in `message` when it cannot run now (lane health, no assignment, daily limit, already running) |
| GET | `/api/v1/channels` | channels the caller can see |
| POST | `/api/v1/channels` | create `{name, kind?, visibility?, topic?, repo_path?, member_ids?}`; kind defaults to `team`, visibility to `public` |
| PATCH | `/api/v1/channels/{id}` | humans only (403 for an agent); update name, topic, repo_path, test_command, default_agent_id, lane_overrides, members; a non-empty `repo_path` must be a git work tree, a non-empty `default_agent_id` must be an agent member of the channel, and every `lane_overrides` entry must name an agent and one of its lanes (400 otherwise); `lane_overrides` replaces the whole map |
| GET | `/api/v1/channels/{id}/messages?before=&limit=` | page of top-level messages (thread replies excluded), newest last; `limit` max 200 |
| GET | `/api/v1/messages/{id}/thread` | root plus replies |
| POST | `/api/v1/channels/{id}/messages` | post `{body, thread_id?, idempotency_key?, attachments?}` where `attachments` is up to 10 `{id, name}` from `POST /api/v1/files` (type and size come from the stored file; `body` may be empty when there is an attachment); mentions are parsed server side; a message with no mention in a direct channel that has exactly one agent member triggers that agent; `@<department>` triggers that department's lead and `@<project>` the project's lead; in a channel that belongs to a project only agents assigned to it run, and each other mentioned agent gets a `notice` with an `assign` action; a reply to a reply attaches to the thread root |
| GET | `/api/v1/search?q=&channel_id=&limit=` | `SearchHit[]` over message bodies in channels the caller can read, best match first (FTS5 with bm25; the last word matches as a prefix). Without FTS5 in the SQLite build it falls back to a substring scan, newest first. `limit` defaults to 30, max 100; a `channel_id` the caller cannot read is 404 |
| GET | `/api/v1/channels/{id}/pins` | `Pin[]`, newest pin first |
| POST | `/api/v1/messages/{id}/pin` | pin the message in its channel; humans only (403 for an agent); repeating it adds no event; emits `message.pinned`; returns `{pinned: true}` |
| DELETE | `/api/v1/messages/{id}/pin` | unpin; humans only; emits `message.unpinned`; returns `{pinned: false}` |
| POST | `/api/v1/files` | upload one file as `multipart/form-data` field `file`; stored by content hash; returns an `Attachment` (201). 413 when it is over `server.max_upload_mb` (default 25), 503 when uploads are not configured. The server sniffs the type; the name is cleaned to a base name |
| GET | `/api/v1/files/{id}?name=` | the stored bytes. Only PNG, JPEG, GIF and WebP are served `inline`; everything else, including HTML and SVG, is `application/octet-stream` with `Content-Disposition: attachment`. Always sent with `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`. `{id}` must be 64 lowercase hex characters |
| POST | `/api/v1/channels/{id}/read` | mark read up to `{seq}` (the channel's `last_seq`); `{event_id}` is also accepted |
| GET | `/api/v1/runs?channel_id=&state=` | runs |
| GET | `/api/v1/runs/{id}` | one run |
| GET | `/api/v1/runs/{id}/output?after=` | raw output lines |
| GET | `/api/v1/runs/{id}/diff` | unified diff of a write run |
| POST | `/api/v1/runs/{id}/cancel` | cancel a run |
| POST | `/api/v1/runs/{id}/retry` | retry `{lane_id?}` on the same or another lane |
| GET | `/api/v1/approvals?state=pending` | approvals |
| POST | `/api/v1/approvals/{id}/resolve` | `{option, commit_message?}`; humans only. An unknown approval is 404. For a write run, `commit_message` replaces the approval's proposed `commit_message` as the Merge commit message. A merge stores the short id of the new commit in `resolution.note`, which the approvals inbox shows as "Merged as <id>" |
| GET | `/api/v1/channels/{id}/compares` | comparisons for a visible channel; each has `id`, `message_id`, `agent_id`, two `candidates` with `lane_id`, optional `run` and `output_tail`, optional `decision` and `winner_lane` |
| POST | `/api/v1/channels/{id}/compares/{compare}/decide` | humans only; `{decision}` is `merge_a`, `merge_b`, `discard_both`, or `combine`; a merge records the winner lane in a `compare.decided` event |
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

`GET /api/v1/stream/head` returns `{"seq": 1234}`, the `seq` of the newest
event (0 for an empty log). A client that keeps its state from the REST reads
fetches the head first, loads its data, then subscribes with `after_seq` set
to that head. Events that happen while it loads are still delivered and
nothing older is replayed. It needs the same sign-in as the other reads.

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
| `message.pinned` | `{channel_id, message_id, pinned_by, pinned_at}` |
| `message.unpinned` | `{channel_id, message_id, pinned_by, pinned_at}` |
| `channel.created`, `channel.updated` | `Channel` |
| `member.updated` | `Member` |
| `presence.changed` | `{member_id, presence}` |
| `run.created`, `run.updated` | `Run` |
| `run.output` | `{run_id, seq, stream: "stdout" or "stderr", text}` |
| `approval.requested`, `approval.resolved` | `Approval` |
| `compare.started` | `{id, channel_id, message_id, agent_id, lanes: [lane_a, lane_b]}` |
| `compare.decided` | `{id, decision, winner_lane?, winner_run?, combine_message_id?, by}` |
| `lane.updated` | `Lane` |
| `lane.switched` | `{run_id, from, to, reason}` |
| `department.updated` | `Department` |
| `project.updated` | `Project` (sent when the Director creates a project or changes its fields or assignments) |
| `routine.updated` | `Routine` (sent when it is switched or has run) |
| `task.created`, `task.updated` | `Task` (the whole task, sent when it is created, edited, started or reported on by a run or an approval) |
| `handoff.created` | `Handoff` plus `message_id` |
| `notice` | `{level: "info" or "warn" or "error", text, action?: NoticeAction}` |

Clients keep the `seq` of the last event they saw and pass it on reconnect,
so nothing is lost while a phone sleeps. Events with the same `seq` are the
same event; clients ignore repeats.

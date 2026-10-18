// Types mirror docs/api.md. Response envelopes that the page does not
// specify are named here and listed in LANE_NOTES.md.

export type ID = string

export type MemberKind = "human" | "agent"
export type Presence = "online" | "idle" | "busy" | "offline"

export interface AgentInfo {
  lanes: string[]
  role?: string
  description?: string
  mode?: RunMode
}

export interface Member {
  id: ID
  kind: MemberKind
  handle: string
  display_name: string
  avatar?: string
  agent?: AgentInfo
  presence: Presence
}

export type ChannelKind = "team" | "department" | "project" | "agent" | "direct"
export type Visibility = "public" | "private" | "direct"

export interface Channel {
  id: ID
  name: string
  kind: ChannelKind
  visibility: Visibility
  topic?: string
  repo_path?: string
  test_command?: string
  default_agent_id?: ID
  /** Persona handle to preferred lane id, set with /lane <persona> <lane>. */
  lane_overrides?: Record<string, string>
  member_ids: ID[]
  unread: number
  last_seq?: number
}

export interface Message {
  id: ID
  channel_id: ID
  thread_id?: ID
  author_id: ID
  body: string
  mentions: ID[]
  options?: string[]
  run_id?: ID
  created_at: string
  edited_at?: string
  reply_count?: number
}

export type RunState =
  | "queued"
  | "running"
  | "waiting_approval"
  | "verifying"
  | "done"
  | "failed"
  | "cancelled"

export type RunMode = "read" | "write"
export type FailureClass = "transient" | "semantic" | "unknown"

export interface Verification {
  ok: boolean
  detail: string
}

export interface DiffStat {
  files: number
  insertions: number
  deletions: number
}

export interface Run {
  id: ID
  channel_id: ID
  trigger_message_id: ID
  agent_id: ID
  base_commit?: string
  lane_id: string
  mode: RunMode
  state: RunState
  worktree?: string
  started_at?: string
  ended_at?: string
  exit_code?: number
  failure_class?: FailureClass
  failure_reason?: string
  /** The failed run this one retried on the next lane. */
  retry_of?: ID
  verification?: Verification
  diff_stat?: DiffStat
}

export type ApprovalStyle = "primary" | "danger"

export interface ApprovalOption {
  key: string
  label: string
  style?: ApprovalStyle
}

export type ApprovalState = "pending" | "resolved" | "expired"

export interface ApprovalResolution {
  option: string
  by: ID
  at: string
  note?: string
}

export interface Approval {
  id: ID
  run_id?: ID
  channel_id: ID
  requested_by: ID
  title: string
  detail: string
  commit_message?: string
  options: ApprovalOption[]
  state: ApprovalState
  resolution?: ApprovalResolution
}

export type LaneHealth = "available" | "conserve" | "exhausted" | "unavailable" | "unknown"
export type LaneCLI = "claude" | "codex" | "grok" | "kimi" | "agy" | "opencode" | "custom"
export type CostClass = "premium" | "standard" | "cheap" | "local"
export type WindowName = "5h" | "day" | "week" | "month"
export type UsageSource = "cli-log" | "probe" | "error" | "manual" | "unknown"

export interface LaneWindow {
  name: WindowName
  used_pct?: number
  tokens?: number
  resets_at?: string
  source: UsageSource
  measured_at?: string
}

export interface LaneError {
  class: string
  message: string
  at: string
}

export interface Lane {
  id: string
  cli: LaneCLI
  model?: string
  cost_class: CostClass
  capacity: number
  running: number
  health: LaneHealth
  health_reason?: string
  windows: LaneWindow[]
  runs_today: number
  tokens_last_hour?: number
  last_error?: LaneError
}

export interface OutputLine {
  seq: number
  stream: "stdout" | "stderr"
  text: string
}

export interface RunOutputPayload extends OutputLine {
  run_id: ID
}

export interface OutputPage {
  lines: OutputLine[]
}

export interface DiffPage {
  diff: string
}

export interface ThreadPage {
  root: Message
  replies: Message[]
}

export interface Health {
  ok: boolean
  version: string
}

export interface ReadResult {
  ok: boolean
}

export interface ApiErrorBody {
  error: {
    code: string
    message: string
  }
}

export type EventType =
  | "message.posted"
  | "message.edited"
  | "channel.created"
  | "channel.updated"
  | "member.updated"
  | "presence.changed"
  | "run.created"
  | "run.updated"
  | "run.output"
  | "approval.requested"
  | "approval.resolved"
  | "lane.updated"
  | "lane.switched"
  | "department.updated"
  | "project.updated"
  | "notice"

export interface StreamEvent<T = unknown> {
  seq: number
  id: ID
  version: number
  type: EventType | (string & {})
  actor: string
  channel_id?: ID
  ts: string
  payload: T
}

export interface ChannelCreate {
  name: string
  kind: ChannelKind
  visibility: Visibility
  topic?: string
  repo_path?: string
  member_ids?: ID[]
}

export interface ChannelPatch {
  name?: string
  topic?: string
  repo_path?: string
  test_command?: string
  default_agent_id?: ID
  member_ids?: ID[]
}

export interface MessageCreate {
  body: string
  thread_id?: ID
  idempotency_key?: string
}

export interface ReadCursor {
  seq: number
}

export interface RetryBody {
  lane_id?: string
}

export interface ResolveBody {
  option: string
  note?: string
  commit_message?: string
}

export interface LanePatch {
  capacity?: number
  health_override?: LaneHealth
  manual_window?: {
    name: WindowName
    used_pct?: number
    resets_at?: string
  }
}

// A button on a notice: "assign" lets the Director put `agent` (a handle)
// into `project` (a handle).
export interface NoticeAction {
  kind: "assign"
  label: string
  project: string
  agent: string
}

export interface NoticeItem {
  id: ID
  channel_id?: ID
  ts: string
  level: "info" | "warn" | "error"
  text: string
  action?: NoticeAction
}

export interface Department {
  handle: string
  display_name: string
  lead?: string
  members: string[]
}

export interface Project {
  handle: string
  name: string
  repo_path?: string
  lead?: string
  channels: string[]
  departments: string[]
  specialists: string[]
}

export interface Org {
  director_id: ID
  departments: Department[]
  projects: Project[]
}

export type AssignKind = "department" | "specialist"

export interface AssignBody {
  kind: AssignKind
  handle: string
}

export interface Device {
  id: ID
  device_name: string
  user_agent: string
  created_at: string
  last_seen_at: string
  current?: boolean
  ok?: boolean
}

export interface LoginBody {
  password: string
  device_name?: string
}

export interface PairBody {
  token: string
  device_name: string
}

export interface PairingTicket {
  token: string
  url: string
  qr_svg: string
  ca_fingerprint: string
  ca_http_url?: string
  expires_at: string
}

export interface CAInfo {
  ca_fingerprint: string
  ca_http_url?: string
  lan_urls?: string[]
}

export const WORKSPACE_NAME = "faztudo"

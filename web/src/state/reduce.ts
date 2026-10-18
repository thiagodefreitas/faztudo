import type {
  Approval,
  Channel,
  Lane,
  Member,
  Message,
  NoticeAction,
  NoticeItem,
  OutputLine,
  Presence,
  Run,
  StreamEvent,
} from "../types"

export interface Snapshot {
  lastSeq: number
  members: Member[]
  channels: Channel[]
  messages: Record<string, Message[]>
  runs: Run[]
  output: Record<string, OutputLine[]>
  approvals: Approval[]
  lanes: Lane[]
  notices: NoticeItem[]
}

export function emptySnapshot(): Snapshot {
  return {
    lastSeq: 0,
    members: [],
    channels: [],
    messages: {},
    runs: [],
    output: {},
    approvals: [],
    lanes: [],
    notices: [],
  }
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

function noticeAction(value: unknown): NoticeAction | null {
  const action = record(value)
  const label = text(action?.label)
  const project = text(action?.project)
  const agent = text(action?.agent)
  if (action?.kind !== "assign" || !label || !project || !agent) return null
  return { kind: "assign", label, project, agent }
}

function outputStream(value: unknown): "stdout" | "stderr" | null {
  if (value === "stdout" || value === "stderr") return value
  return null
}

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const index = list.findIndex((entry) => entry.id === item.id)
  if (index === -1) return [...list, item]
  const copy = list.slice()
  copy[index] = item
  return copy
}

export function sortMessages(list: Message[]): Message[] {
  return list.slice().sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
}

function isMessage(value: unknown): value is Message {
  const item = record(value)
  return Boolean(item && text(item.id) && text(item.channel_id) && typeof item.body === "string" && text(item.author_id))
}

function isChannel(value: unknown): value is Channel {
  const item = record(value)
  return Boolean(item && text(item.id) && text(item.name) && Array.isArray(item.member_ids))
}

function isMember(value: unknown): value is Member {
  const item = record(value)
  return Boolean(item && text(item.id) && text(item.handle) && text(item.display_name))
}

function isRun(value: unknown): value is Run {
  const item = record(value)
  return Boolean(item && text(item.id) && text(item.channel_id) && text(item.state) && text(item.lane_id))
}

function isApproval(value: unknown): value is Approval {
  const item = record(value)
  return Boolean(item && text(item.id) && text(item.channel_id) && text(item.title) && Array.isArray(item.options))
}

function isLane(value: unknown): value is Lane {
  const item = record(value)
  return Boolean(item && text(item.id) && text(item.health) && Array.isArray(item.windows))
}

function findMessageChannel(state: Snapshot, messageId: string): string | undefined {
  for (const [channelId, messages] of Object.entries(state.messages)) {
    if (messages.some((message) => message.id === messageId)) return channelId
  }
  return undefined
}

export function reduce(state: Snapshot, event: StreamEvent): Snapshot {
  if (!Number.isFinite(event.seq) || event.seq <= state.lastSeq) return state
  const next: Snapshot = { ...state, lastSeq: event.seq }
  switch (event.type) {
    case "message.posted": {
      if (!isMessage(event.payload)) return next
      const channelId = event.payload.channel_id
      const current = state.messages[channelId] ?? []
      const incoming = event.payload
      const known = current.some((item) => item.id === incoming.id)
      let list = upsert(current, incoming)
      // The stream carries the message as posted, without a count. A new reply
      // bumps its cached root; a replayed reply is already known and does not.
      if (incoming.thread_id && !known) {
        const rootId = incoming.thread_id
        list = list.map((item) => (item.id === rootId ? { ...item, reply_count: (item.reply_count ?? 0) + 1 } : item))
      }
      next.messages = { ...state.messages, [channelId]: sortMessages(list) }
      return next
    }
    case "message.edited": {
      const payload = record(event.payload)
      const id = text(payload?.id)
      const body = payload && typeof payload.body === "string" ? payload.body : null
      const editedAt = text(payload?.edited_at)
      if (!id || body === null) return next
      const channelId = event.channel_id ?? findMessageChannel(state, id)
      if (!channelId) return next
      const current = state.messages[channelId] ?? []
      next.messages = {
        ...state.messages,
        [channelId]: current.map((message) =>
          message.id === id ? { ...message, body, ...(editedAt ? { edited_at: editedAt } : {}) } : message,
        ),
      }
      return next
    }
    case "channel.created":
    case "channel.updated": {
      if (!isChannel(event.payload)) return next
      next.channels = upsert(state.channels, event.payload)
      return next
    }
    case "member.updated": {
      if (!isMember(event.payload)) return next
      next.members = upsert(state.members, event.payload)
      return next
    }
    case "presence.changed": {
      const payload = record(event.payload)
      const memberId = text(payload?.member_id)
      const presence = text(payload?.presence) as Presence | null
      if (!memberId || !presence) return next
      next.members = state.members.map((member) => (member.id === memberId ? { ...member, presence } : member))
      return next
    }
    case "run.created":
    case "run.updated": {
      if (!isRun(event.payload)) return next
      next.runs = upsert(state.runs, event.payload)
      return next
    }
    case "run.output": {
      const payload = record(event.payload)
      const runId = text(payload?.run_id)
      const seq = typeof payload?.seq === "number" ? payload.seq : null
      const stream = outputStream(payload?.stream)
      const line = payload && typeof payload.text === "string" ? payload.text : null
      if (!runId || seq === null || !stream || line === null) return next
      const current = state.output[runId] ?? []
      if (current.some((item) => item.seq === seq)) return next
      const lines: OutputLine[] = [...current, { seq, stream, text: line }]
      lines.sort((a, b) => a.seq - b.seq)
      next.output = { ...state.output, [runId]: lines }
      return next
    }
    case "approval.requested":
    case "approval.resolved": {
      if (!isApproval(event.payload)) return next
      next.approvals = upsert(state.approvals, event.payload)
      return next
    }
    case "lane.updated": {
      if (!isLane(event.payload)) return next
      next.lanes = upsert(state.lanes, event.payload)
      return next
    }
    case "lane.switched": {
      const payload = record(event.payload)
      const runId = text(payload?.run_id)
      const from = text(payload?.from) ?? "unknown"
      const to = text(payload?.to)
      const reason = text(payload?.reason) ?? ""
      if (runId && to) {
        next.runs = state.runs.map((run) => (run.id === runId ? { ...run, lane_id: to } : run))
      }
      next.notices = [
        ...state.notices,
        {
          id: event.id,
          ...(event.channel_id ? { channel_id: event.channel_id } : {}),
          ts: event.ts,
          level: "info",
          text: `Lane switched from ${from} to ${to ?? "unknown"}. ${reason}`.trim(),
          ...(runId ? { run_id: runId } : {}),
        },
      ]
      return next
    }
    case "notice": {
      const payload = record(event.payload)
      const level = payload?.level
      const body = text(payload?.text)
      if ((level !== "info" && level !== "warn" && level !== "error") || !body) return next
      const action = noticeAction(payload?.action)
      next.notices = [
        ...state.notices,
        {
          id: event.id,
          ...(event.channel_id ? { channel_id: event.channel_id } : {}),
          ts: event.ts,
          level,
          text: body,
          ...(action ? { action } : {}),
        },
      ]
      return next
    }
    default:
      return next
  }
}

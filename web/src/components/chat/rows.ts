import { collapseAgentChat } from "../../lib/agent-chat"
import { continuesGroup } from "../../lib/group"
import type { Member, Message, NoticeItem } from "../../types"
import type { PendingMessage } from "../../state/queries"
import { dayKey, dayLabel } from "./day"
import { matchesFilter, type ChatFilter, type FilterContext } from "./filters"

export type Row =
  | { kind: "message"; key: string; at: string; message: Message; grouped: boolean; lastInGroup: boolean }
  | { kind: "agents"; key: string; at: string; messages: Message[] }
  | { kind: "notice"; key: string; at: string; notice: NoticeItem }
  | { kind: "pending"; key: string; at: string; pending: PendingMessage }
  | { kind: "day"; key: string; at: string; label: string }
  | { kind: "new"; key: string; at: string }
  | { kind: "catchup"; key: string; at: string }

/** One header per author within five minutes. A run card always starts its own group. */
export function groupsWith(prev: Message | undefined, next: Message): boolean {
  if (!prev || prev.run_id || next.run_id) return false
  return continuesGroup(prev, next)
}

/**
 * The messages the reader has not seen: the last `count` that others wrote.
 * The server only tells us how many are unread, so the newest ones stand in.
 */
export function unreadIds(all: Message[], count: number, meId: string | undefined): Set<string> {
  if (count <= 0) return new Set()
  const others = all.filter((message) => message.author_id !== meId)
  return new Set(others.slice(-count).map((message) => message.id))
}

export interface RowInput {
  /** Top-level messages in order. */
  messages: Message[]
  members: Member[]
  notices: NoticeItem[]
  pending: PendingMessage[]
  filter: ChatFilter
  context: FilterContext
  unread: Set<string>
  /** Show the catch-up card under the New divider. */
  catchUp: boolean
  now: number
}

type Content = Exclude<Row, { kind: "day" | "new" | "catchup" }>

export function buildRows(input: RowInput): Row[] {
  const filtered = input.filter !== "all"
  const messages = filtered ? input.messages.filter((message) => matchesFilter(message, input.filter, input.context)) : input.messages
  const content: Content[] = [
    ...collapseAgentChat(messages, input.members).map((segment): Content =>
      segment.kind === "message"
        ? { kind: "message", key: segment.message.id, at: segment.message.created_at, message: segment.message, grouped: false, lastInGroup: true }
        : { kind: "agents", key: `agents:${segment.messages[0]?.id}`, at: segment.messages[0]?.created_at ?? "", messages: segment.messages },
    ),
    ...(filtered ? [] : input.notices.map((notice): Content => ({ kind: "notice", key: notice.id, at: notice.ts, notice }))),
    ...(filtered ? [] : input.pending.map((item): Content => ({ kind: "pending", key: `pending:${item.key}`, at: item.createdAt, pending: item }))),
  ].sort((a, b) => a.at.localeCompare(b.at) || a.key.localeCompare(b.key))

  const isUnread = (row: Content) =>
    row.kind === "message" ? input.unread.has(row.message.id) : row.kind === "agents" ? row.messages.some((m) => input.unread.has(m.id)) : false
  const firstUnread = input.unread.size > 0 ? content.find(isUnread)?.key : undefined

  const out: Row[] = []
  let prevDay = ""
  let prev: Row | undefined
  for (const row of content) {
    let broke = false
    const day = dayKey(row.at)
    if (day && day !== prevDay) {
      out.push({ kind: "day", key: `day:${day}`, at: row.at, label: dayLabel(row.at, input.now) })
      prevDay = day
      broke = true
    }
    if (row.key === firstUnread) {
      out.push({ kind: "new", key: "new", at: row.at })
      if (input.catchUp) out.push({ kind: "catchup", key: "catchup", at: row.at })
      broke = true
    }
    if (row.kind === "message" && !broke && prev?.kind === "message") row.grouped = groupsWith(prev.message, row.message)
    out.push(row)
    prev = row
  }
  out.forEach((row, index) => {
    const next = out[index + 1]
    if (row.kind === "message") row.lastInGroup = !(next?.kind === "message" && next.grouped)
  })
  return out
}

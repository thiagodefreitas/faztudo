import type { Channel, Message } from "../types"

// One line of plain text for a list row: markdown syntax removed, whitespace
// collapsed.
export function plainPreview(body: string): string {
  return body
    .replace(/```[\s\S]*?```/g, " code ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/(\*\*|__|~~|[*_`])/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

export function relativeTime(iso: string | undefined, now: number): string {
  if (!iso) return ""
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ""
  const min = Math.max(0, Math.floor((now - then) / 60000))
  if (min < 1) return "now"
  if (min < 60) return `${min}m`
  const hours = Math.floor(min / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  return new Date(then).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

// Unread conversations the reader cannot see, in list order.
export function offscreenUnread(items: InboxItem[], visible: Set<string>): string[] {
  return items.filter((item) => item.channel.unread > 0 && !visible.has(item.channel.id)).map((item) => item.channel.id)
}

export interface InboxItem {
  channel: Channel
  last: Message | undefined
}

export type InboxFilter = "all" | "unread" | "agents" | "channels"

// Pinned chats first (a direct chat with a pinned agent), then by last activity.
export function orderInbox(items: InboxItem[], isPinned: (item: InboxItem) => boolean): InboxItem[] {
  const sorted = sortInbox(items)
  return [...sorted.filter(isPinned), ...sorted.filter((item) => !isPinned(item))]
}

export function filterInbox(
  items: InboxItem[],
  filter: InboxFilter,
  isAgentChat: (item: InboxItem) => boolean,
  isDirectChat: (item: InboxItem) => boolean,
): InboxItem[] {
  switch (filter) {
    case "all":
      return items
    case "unread":
      return items.filter((item) => item.channel.unread > 0)
    case "agents":
      return items.filter(isAgentChat)
    case "channels":
      return items.filter((item) => !isDirectChat(item))
  }
}

// Newest activity first. A conversation with no messages sorts last, by name.
export function sortInbox(items: InboxItem[]): InboxItem[] {
  return items.slice().sort((a, b) => {
    const at = a.last ? Date.parse(a.last.created_at) : 0
    const bt = b.last ? Date.parse(b.last.created_at) : 0
    return bt - at || a.channel.name.localeCompare(b.channel.name)
  })
}

import type { Message } from "../../types"

export interface ThreadSummary {
  root: Message
  /** Author ids: the root's author first, then repliers. */
  participants: string[]
  replies: number
  lastReplyAt: string
  unread: boolean
}

/**
 * Every thread with replies in a channel, newest activity first. Replies the
 * cache holds give participants and the last reply time; the root's own count
 * covers replies that are not loaded.
 */
export function listThreads(all: Message[], unread: Set<string>): ThreadSummary[] {
  const out: ThreadSummary[] = []
  for (const root of all) {
    if (root.thread_id) continue
    const loaded = all.filter((message) => message.thread_id === root.id)
    const replies = Math.max(root.reply_count ?? 0, loaded.length)
    if (replies === 0) continue
    const people = [root.author_id]
    for (const reply of loaded) if (!people.includes(reply.author_id)) people.push(reply.author_id)
    const last = loaded.reduce((at, reply) => (reply.created_at > at ? reply.created_at : at), root.created_at)
    out.push({
      root,
      participants: people,
      replies,
      lastReplyAt: last,
      unread: loaded.some((reply) => unread.has(reply.id)),
    })
  }
  return out.sort((a, b) => b.lastReplyAt.localeCompare(a.lastReplyAt))
}

import type { Message } from "../types"

export const GROUP_WINDOW_MS = 5 * 60 * 1000

// A message continues the previous group when the same member wrote it
// within five minutes of the previous message.
export function continuesGroup(prev: Message | undefined, next: Message): boolean {
  if (!prev || prev.author_id !== next.author_id) return false
  const gap = Date.parse(next.created_at) - Date.parse(prev.created_at)
  return Number.isFinite(gap) && gap >= 0 && gap < GROUP_WINDOW_MS
}

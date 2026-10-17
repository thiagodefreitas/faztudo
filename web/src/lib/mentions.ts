import type { Member } from "../types"

export interface MentionQuery {
  start: number
  query: string
}

// The open mention is the @token touching the cursor. An @ inside a word
// (an email address) is not a mention.
export function mentionQuery(text: string, cursor: number): MentionQuery | null {
  const upto = text.slice(0, cursor)
  const match = /(^|\s)@([a-z0-9-]*)$/i.exec(upto)
  if (!match) return null
  return { start: upto.lastIndexOf("@"), query: match[2] ?? "" }
}

export function mentionHandles(body: string): string[] {
  const found: string[] = []
  const re = /(^|[^a-z0-9])@([a-z0-9][a-z0-9-]*)/gi
  for (const match of body.matchAll(re)) {
    const handle = match[2]?.toLowerCase()
    if (handle) found.push(handle)
  }
  return found
}

export function filterMembers(members: Member[], query: string): Member[] {
  const needle = query.toLowerCase()
  return members
    .filter((member) => {
      if (!needle) return true
      return (
        member.handle.toLowerCase().includes(needle) ||
        member.display_name.toLowerCase().includes(needle)
      )
    })
    .sort((a, b) => {
      const aPrefix = a.handle.toLowerCase().startsWith(needle) ? 0 : 1
      const bPrefix = b.handle.toLowerCase().startsWith(needle) ? 0 : 1
      if (aPrefix !== bPrefix) return aPrefix - bPrefix
      return a.handle.localeCompare(b.handle)
    })
    .slice(0, 8)
}

export function applyMention(
  text: string,
  cursor: number,
  handle: string,
): { text: string; cursor: number } {
  const found = mentionQuery(text, cursor)
  const insert = `@${handle} `
  if (!found) {
    const next = text.slice(0, cursor) + insert + text.slice(cursor)
    return { text: next, cursor: cursor + insert.length }
  }
  const next = text.slice(0, found.start) + insert + text.slice(cursor)
  return { text: next, cursor: found.start + insert.length }
}

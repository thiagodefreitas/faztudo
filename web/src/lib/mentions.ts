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

// Blank out backtick spans: a run of n backticks opens a span that ends at
// the next run of exactly n. An unclosed run is plain text.
function stripInlineCode(line: string): string {
  if (!line.includes("`")) return line
  let out = ""
  let i = 0
  while (i < line.length) {
    if (line[i] !== "`") {
      out += line[i]
      i += 1
      continue
    }
    const start = i
    while (i < line.length && line[i] === "`") i += 1
    const n = i - start
    let end = -1
    let j = i
    while (j < line.length) {
      if (line[j] !== "`") {
        j += 1
        continue
      }
      const k = j
      while (j < line.length && line[j] === "`") j += 1
      if (j - k === n) {
        end = j
        break
      }
    }
    if (end < 0) {
      out += line.slice(start, i)
      continue
    }
    out += " ".repeat(end - start)
    i = end
  }
  return out
}

// Same rules as the server: mentions inside inline code, fenced blocks and
// quoted lines (starting with ">") are text, not mentions.
export function mentionHandles(body: string): string[] {
  const found: string[] = []
  const re = /(^|[^a-z0-9])@([a-z0-9][a-z0-9_-]*)/gi
  let fence = ""
  for (const line of body.split("\n")) {
    const trimmed = line.replace(/^[ \t]+/, "")
    if (fence) {
      const rest = trimmed.replace(/[ \t\r]+$/, "")
      if (trimmed.startsWith(fence) && rest.split("").every((c) => c === fence[0])) fence = ""
      continue
    }
    const open = /^(`{3,}|~{3,})/.exec(trimmed)
    if (open) {
      fence = open[1] ?? ""
      continue
    }
    if (trimmed.startsWith(">")) continue
    for (const match of stripInlineCode(line).matchAll(re)) {
      const handle = match[2]?.toLowerCase()
      if (handle) found.push(handle)
    }
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

const START = "\u0001"
const END = "\u0002"

export interface SnippetPart {
  text: string
  hit: boolean
}

// The server marks each search match with U+0001 and U+0002 so the page can
// highlight without ever treating message text as HTML.
export function splitSnippet(snippet: string): SnippetPart[] {
  const parts: SnippetPart[] = []
  let rest = snippet
  while (rest) {
    const start = rest.indexOf(START)
    if (start === -1) {
      parts.push({ text: rest.replaceAll(END, ""), hit: false })
      break
    }
    if (start > 0) parts.push({ text: rest.slice(0, start), hit: false })
    const after = rest.slice(start + 1)
    const end = after.indexOf(END)
    if (end === -1) {
      parts.push({ text: after, hit: true })
      break
    }
    parts.push({ text: after.slice(0, end), hit: true })
    rest = after.slice(end + 1)
  }
  return parts.filter((part) => part.text !== "")
}

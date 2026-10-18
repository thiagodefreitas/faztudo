/** A long answer shows this many lines before "Show all". */
export const FOLD_LINES = 12

export interface Folded {
  /** Markdown to show while folded. */
  head: string
  /** Headings of the part that is hidden, in order. */
  headings: string[]
  /** Lines in the hidden part. */
  hidden: number
}

function fenceCount(lines: string[]): number {
  return lines.filter((line) => /^\s*(```|~~~)/.test(line)).length
}

/**
 * The first twelve lines of a long answer, cut at a blank line so a
 * paragraph or list is not split, and never inside a code block. Returns
 * null when the answer is short enough to show whole.
 */
export function foldAnswer(body: string, limit = FOLD_LINES): Folded | null {
  const lines = body.replace(/\s+$/, "").split("\n")
  if (lines.length <= limit) return null
  let cut = limit
  // Prefer the last blank line inside the limit; the first two lines always stay.
  for (let i = limit; i >= 2; i--) {
    if ((lines[i] ?? "").trim() === "" && fenceCount(lines.slice(0, i)) % 2 === 0) {
      cut = i
      break
    }
  }
  let head = lines.slice(0, cut)
  if (fenceCount(head) % 2 === 1) head = [...head, "```"]
  const rest = lines.slice(cut)
  const headings: string[] = []
  let fenced = fenceCount(lines.slice(0, cut)) % 2 === 1
  for (const line of rest) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced
    const match = !fenced ? /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line) : null
    if (match?.[1]) headings.push(match[1])
  }
  return { head: head.join("\n").replace(/\s+$/, ""), headings, hidden: rest.filter((line) => line.trim() !== "").length }
}

/** The first sentence of the first paragraph, for one-line gists. */
export function firstSentence(body: string, max = 140): string {
  const text = body
    .split(/\n\s*\n/)
    .map((part) => part.replace(/^#+\s+/gm, "").replace(/\s+/g, " ").trim())
    .find((part) => part !== "")
  if (!text) return ""
  const end = /[.!?](\s|$)/.exec(text)
  const sentence = end ? text.slice(0, end.index + 1) : text
  return sentence.length > max ? `${sentence.slice(0, max - 3).trimEnd()}...` : sentence
}

export type DiffLineKind = "add" | "del" | "hunk" | "meta" | "context"

export interface DiffLine {
  kind: DiffLineKind
  text: string
}

export function parseDiff(diff: string): DiffLine[] {
  const lines = diff.split("\n")
  if (lines.at(-1) === "") lines.pop()
  return lines.map((text) => {
    if (
      text.startsWith("diff ") ||
      text.startsWith("index ") ||
      text.startsWith("---") ||
      text.startsWith("+++")
    ) {
      return { kind: "meta", text }
    }
    if (text.startsWith("@@")) return { kind: "hunk", text }
    if (text.startsWith("+")) return { kind: "add", text }
    if (text.startsWith("-")) return { kind: "del", text }
    return { kind: "context", text }
  })
}

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

export interface DiffFile {
  path: string
  additions: number
  deletions: number
  /** The file's lines from its "diff --git" header on. */
  lines: DiffLine[]
}

function pathOf(header: string): string {
  const match = /^diff --git a\/(.+) b\/(.+)$/.exec(header)
  return match?.[2] ?? header.replace(/^diff\s+(--\w+\s+)?/, "")
}

/**
 * One entry per file of a git diff, with its added and removed line counts.
 * Inside a hunk every "+" and "-" line is content, even one that starts with
 * "+++" or "---".
 */
export function splitFiles(diff: string): DiffFile[] {
  const files: DiffFile[] = []
  let inHunk = false
  const raw = diff.split("\n")
  if (raw.at(-1) === "") raw.pop()
  for (const text of raw) {
    if (text.startsWith("diff ")) {
      files.push({ path: pathOf(text), additions: 0, deletions: 0, lines: [{ kind: "meta", text }] })
      inHunk = false
      continue
    }
    const file = files.at(-1)
    if (!file) continue
    if (text.startsWith("@@")) {
      inHunk = true
      file.lines.push({ kind: "hunk", text })
    } else if (!inHunk) {
      file.lines.push({ kind: "meta", text })
    } else if (text.startsWith("+")) {
      file.additions += 1
      file.lines.push({ kind: "add", text })
    } else if (text.startsWith("-")) {
      file.deletions += 1
      file.lines.push({ kind: "del", text })
    } else {
      file.lines.push({ kind: "context", text })
    }
  }
  return files
}

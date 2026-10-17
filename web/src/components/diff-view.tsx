import { parseDiff, type DiffLineKind } from "../lib/diff"
import { cx } from "../lib/cx"

const KIND: Record<DiffLineKind, string> = {
  add: "bg-ok-soft",
  del: "bg-danger-soft",
  hunk: "text-accent",
  meta: "text-muted",
  context: "",
}

export function DiffView({ diff }: { diff: string }) {
  const lines = parseDiff(diff)
  if (lines.length === 0) return <p className="text-[13px] text-muted">The diff is empty.</p>
  return (
    <div className="overflow-auto font-mono text-[12px] leading-5">
      {lines.map((line, index) => (
        <div key={index} className={cx("whitespace-pre px-2", KIND[line.kind])}>
          {line.text || " "}
        </div>
      ))}
    </div>
  )
}

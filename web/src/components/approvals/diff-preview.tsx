import { useMemo, useState } from "react"
import { cx } from "../../lib/cx"
import { splitFiles, type DiffFile } from "../../lib/diff"
import { HighlightedLine, languageOfPath } from "../markdown"

/** Files whose changes show open until the person asks for the rest. */
export const PREVIEW_FILES = 2
const LINE_CAP = 60

const KIND: Record<string, string> = {
  add: "bg-ok-soft",
  del: "bg-danger-soft",
  hunk: "text-accent",
}

function FileBody({ file }: { file: DiffFile }) {
  const [all, setAll] = useState(false)
  const language = languageOfPath(file.path)
  // The header lines (diff, index, ---, +++) repeat the file row above.
  const body = file.lines.filter((line, index) => index > 0 && (line.kind === "hunk" || line.kind === "add" || line.kind === "del" || line.kind === "context"))
  const shown = all ? body : body.slice(0, LINE_CAP)
  return (
    <div className="overflow-x-auto border-t border-line bg-code font-mono text-[12px] leading-5">
      {shown.map((line, index) => (
        <div key={index} className={cx("whitespace-pre px-2", KIND[line.kind])}>
          {line.kind === "hunk" ? (
            line.text
          ) : (
            <>
              <span className="select-none text-faint">{line.text.slice(0, 1) || " "}</span>
              <HighlightedLine source={line.text.slice(1)} language={language} />
            </>
          )}
        </div>
      ))}
      {body.length === 0 && <p className="px-2 py-1 text-muted">No line changes (binary or renamed).</p>}
      {body.length > shown.length && (
        <button type="button" onClick={() => setAll(true)} className="min-h-8 px-2 text-[12px] font-medium text-accent hover:underline">
          Show {body.length - shown.length} more lines
        </button>
      )}
    </div>
  )
}

/**
 * The files of a diff with +/- per file. The first few open inline with
 * syntax colors; "Show all files" opens the rest.
 */
export function DiffPreview({ diff, preview = PREVIEW_FILES }: { diff: string; preview?: number }) {
  const files = useMemo(() => splitFiles(diff), [diff])
  const [open, setOpen] = useState<Set<string>>(() => new Set(files.slice(0, preview).map((file) => file.path)))
  if (files.length === 0) return null
  const hidden = files.filter((file) => !open.has(file.path)).length

  function toggle(path: string) {
    setOpen((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  return (
    <section aria-label="Changed files" className="mt-3">
      <ul className="overflow-hidden rounded-md border border-line bg-surface">
        {files.map((file, index) => {
          const expanded = open.has(file.path)
          return (
            <li key={`${file.path}:${index}`} className={cx(index > 0 && "border-t border-line")}>
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => toggle(file.path)}
                className="flex min-h-9 w-full items-center gap-2 px-2 text-left text-[12px] hover:bg-canvas"
              >
                <span aria-hidden="true" className="w-3 text-faint">
                  {expanded ? "v" : ">"}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono">{file.path}</span>
                <span className="font-mono text-ok">+{file.additions}</span>
                <span className="font-mono text-danger">-{file.deletions}</span>
              </button>
              {expanded && <FileBody file={file} />}
            </li>
          )
        })}
      </ul>
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setOpen(new Set(files.map((file) => file.path)))}
          className="mt-1 min-h-8 text-[12px] font-medium text-accent hover:underline"
        >
          Show all {files.length} files
        </button>
      )}
    </section>
  )
}

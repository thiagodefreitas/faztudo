import { useState } from "react"

const SHOWN_LINES = 6

// Text that can run long (check output, a failure reason): the first lines
// are visible and "Show all" opens the rest. Short text renders as is.
export function FoldedText({ text, className }: { text: string; className?: string }) {
  const [open, setOpen] = useState(false)
  const lines = text.split("\n")
  const long = lines.length > SHOWN_LINES
  const shown = long && !open ? lines.slice(0, SHOWN_LINES).join("\n") : text
  return (
    <>
      <pre className={className}>{shown}</pre>
      {long && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="mt-1 inline-flex min-h-8 items-center text-[12px] text-muted underline hover:text-ink"
        >
          {open ? "Show less" : `Show all (${lines.length} lines)`}
        </button>
      )}
    </>
  )
}

import { useMemo, useState } from "react"
import { foldAnswer } from "../lib/answer-fold"
import type { ChannelRef } from "../lib/channel-links"
import { Markdown } from "./markdown"

// A long agent answer shows its first twelve lines and the headings of the
// rest, with Show all. Short answers, and anything a person wrote, show whole.
export function AnswerBody({ text, channels, fold }: { text: string; channels: ChannelRef[] | undefined; fold: boolean }) {
  const [open, setOpen] = useState(false)
  const folded = useMemo(() => (fold ? foldAnswer(text) : null), [fold, text])
  if (!folded) return <Markdown text={text} channels={channels} />
  if (open) {
    return (
      <>
        <Markdown text={text} channels={channels} />
        <button type="button" aria-expanded onClick={() => setOpen(false)} className="min-h-8 text-[12px] font-medium text-accent hover:underline">
          Show less
        </button>
      </>
    )
  }
  return (
    <>
      <Markdown text={folded.head} channels={channels} />
      {folded.headings.length > 0 && (
        <p className="mt-1 text-[12px] text-muted">
          <span className="text-faint">Further down: </span>
          {folded.headings.slice(0, 6).join(", ")}
          {folded.headings.length > 6 ? ` and ${folded.headings.length - 6} more` : ""}
        </p>
      )}
      <button
        type="button"
        aria-expanded={false}
        onClick={() => setOpen(true)}
        className="min-h-8 text-[12px] font-medium text-accent hover:underline"
      >
        Show all ({folded.hidden} more {folded.hidden === 1 ? "line" : "lines"})
      </button>
    </>
  )
}

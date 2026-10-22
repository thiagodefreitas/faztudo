import { useState } from "react"
import type { RunPrompt } from "../types"
import { FoldedText } from "./folded-text"
import { LessonsDialog } from "./lessons/lessons-dialog"

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  return `${Math.round(bytes / 1024)} KB`
}

const labels: Record<string, string> = {
  summary: "Summary",
  working: "Working now",
  pinned: "Pinned in this channel",
  lessons: "Lessons",
  transcript: "Transcript",
  request: "Request",
  instructions: "Instructions",
}

// The lessons section: its header, then one line per lesson that opens the
// list of the persona's lessons, where it can be edited or removed.
function LessonLines({ text, persona }: { text: string; persona: string }) {
  const [open, setOpen] = useState(false)
  const lines = text.split("\n").filter((line) => line.trim() !== "")
  return (
    <div className="mt-2 text-[12px] leading-5">
      <ul className="space-y-1">
        {lines.map((line, index) =>
          line.startsWith("- ") ? (
            <li key={index}>
              <button type="button" onClick={() => setOpen(true)} className="break-words text-left text-muted underline-offset-2 hover:text-ink hover:underline">
                {line.slice(2)}
              </button>
            </li>
          ) : (
            <li key={index} className="text-faint">
              {line}
            </li>
          ),
        )}
      </ul>
      {open && <LessonsDialog persona={persona} open onOpenChange={setOpen} />}
    </div>
  )
}

export function RunContext({ data, persona }: { data: RunPrompt; persona?: string }) {
  const bytes = new TextEncoder().encode(data.prompt)
  const decoder = new TextDecoder()

  return (
    <div className="space-y-2 p-3">
      {data.sections.map((section) => {
        const text = section.spans.map((span) => decoder.decode(bytes.slice(span.offset, span.offset + span.bytes))).join("")
        return (
          <details key={section.name} className="rounded border border-line px-2 py-1">
            <summary className="cursor-pointer text-[12px] font-medium text-ink">
              {labels[section.name] ?? section.name}, {size(section.bytes)}
            </summary>
            {section.name === "lessons" && persona ? (
              <LessonLines text={text} persona={persona} />
            ) : (
              <FoldedText text={text} className="mt-2 whitespace-pre-wrap break-words font-mono text-[12px] leading-5 text-muted" />
            )}
          </details>
        )
      })}
    </div>
  )
}

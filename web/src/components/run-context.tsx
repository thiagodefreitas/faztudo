import type { RunPrompt } from "../types"
import { FoldedText } from "./folded-text"

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  return `${Math.round(bytes / 1024)} KB`
}

const labels: Record<string, string> = {
  summary: "Summary",
  working: "Working now",
  pinned: "Pinned in this channel",
  transcript: "Transcript",
  request: "Request",
  instructions: "Instructions",
}

export function RunContext({ data }: { data: RunPrompt }) {
  const bytes = new TextEncoder().encode(data.prompt)
  const decoder = new TextDecoder()

  return (
    <div className="space-y-2 p-3">
      {data.sections.map((section) => (
        <details key={section.name} className="rounded border border-line px-2 py-1">
          <summary className="cursor-pointer text-[12px] font-medium text-ink">
            {labels[section.name] ?? section.name}, {size(section.bytes)}
          </summary>
          <FoldedText
            text={section.spans.map((span) => decoder.decode(bytes.slice(span.offset, span.offset + span.bytes))).join("")}
            className="mt-2 whitespace-pre-wrap break-words font-mono text-[12px] leading-5 text-muted"
          />
        </details>
      ))}
    </div>
  )
}

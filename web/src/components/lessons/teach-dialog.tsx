import * as Dialog from "@radix-ui/react-dialog"
import { useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { api } from "../../api/client"
import { LESSON_MAX } from "../../lib/lessons"
import { qk } from "../../state/keys"
import { replaceById } from "../../state/merge"
import type { Lesson } from "../../types"
import { LessonsDialog } from "./lessons-dialog"

const FIELD = "mt-1 min-h-10 w-full rounded border border-line bg-canvas px-2 text-[13px] md:min-h-8"

// "Teach @persona...": a short correction that every later run of the persona
// sees, in this channel or everywhere. It is kept in the database, listed in
// the lessons panel and shown in the run Context tab.
export function TeachDialog({
  persona,
  channelId,
  channelName,
  sourceMessageId,
  open,
  onOpenChange,
}: {
  persona: string
  channelId: string
  channelName: string
  sourceMessageId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const qc = useQueryClient()
  const [text, setText] = useState("")
  const [scope, setScope] = useState<"channel" | "everywhere">("channel")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [listing, setListing] = useState(false)

  const length = [...text.trim()].length
  const ready = length >= 1 && length <= LESSON_MAX

  async function save() {
    setError(null)
    setBusy(true)
    try {
      const lesson = await api.createLesson({
        persona,
        text: text.trim(),
        ...(scope === "channel" ? { channel_id: channelId } : {}),
        ...(sourceMessageId ? { source_message_id: sourceMessageId } : {}),
      })
      qc.setQueryData<Lesson[] | undefined>(qk.lessons, (current) => (current ? replaceById(current, lesson) : current))
      setSaved(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the lesson.")
    } finally {
      setBusy(false)
    }
  }

  if (listing) return <LessonsDialog persona={persona} open onOpenChange={(next) => (next ? undefined : onOpenChange(false))} />

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/40" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-[10vh] z-50 flex max-h-[80vh] w-[min(32rem,calc(100vw-1.5rem))] -translate-x-1/2 flex-col overflow-hidden rounded-lg border border-line bg-surface shadow-lg"
        >
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <Dialog.Title className="truncate text-[14px] font-semibold">Teach @{persona}</Dialog.Title>
            <Dialog.Close className="min-h-10 rounded px-2 text-[13px] text-muted hover:text-ink md:min-h-8">Close</Dialog.Close>
          </div>
          {saved ? (
            <div className="space-y-3 p-4 text-[13px]">
              <p role="status">@{persona} will see this in its next runs.</p>
              <button type="button" onClick={() => setListing(true)} className="min-h-10 font-medium text-accent hover:underline md:min-h-8">
                Open lessons
              </button>
            </div>
          ) : (
            <form
              className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4"
              onSubmit={(event) => {
                event.preventDefault()
                if (ready && !busy) void save()
              }}
            >
              <label className="block text-[12px] text-muted">
                Lesson
                <input
                  autoFocus
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  placeholder={`What should @${persona} do differently next time?`}
                  className={FIELD}
                />
              </label>
              <p className={`text-right font-mono text-[11px] ${length > LESSON_MAX ? "text-danger" : "text-faint"}`}>
                {length}/{LESSON_MAX}
              </p>
              <fieldset className="space-y-1 text-[13px]">
                <legend className="text-[12px] text-muted">Applies</legend>
                <label className="flex min-h-10 items-center gap-2 md:min-h-8">
                  <input type="radio" name="lesson-scope" checked={scope === "channel"} onChange={() => setScope("channel")} />
                  In this channel{channelName ? ` (#${channelName})` : ""}
                </label>
                <label className="flex min-h-10 items-center gap-2 md:min-h-8">
                  <input type="radio" name="lesson-scope" checked={scope === "everywhere"} onChange={() => setScope("everywhere")} />
                  Everywhere
                </label>
              </fieldset>
              {error && (
                <p role="alert" className="text-[13px] text-danger">
                  {error}
                </p>
              )}
              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={!ready || busy}
                  className="min-h-10 rounded bg-accent px-4 text-[13px] font-medium text-white disabled:opacity-50 md:min-h-8"
                >
                  Save
                </button>
              </div>
            </form>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

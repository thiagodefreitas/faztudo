import * as Dialog from "@radix-ui/react-dialog"
import { useQueryClient } from "@tanstack/react-query"
import { useEffect, useRef, useState } from "react"
import { api } from "../../api/client"
import { LESSON_MAX } from "../../lib/lessons"
import { qk } from "../../state/keys"
import { replaceById } from "../../state/merge"
import { useChannels, useLessons, useMe } from "../../state/queries"
import type { Lesson } from "../../types"

const UNDO_MS = 5000
const FIELD = "min-h-10 w-full rounded border border-line bg-canvas px-2 text-[13px] md:min-h-8"
const SMALL = "min-h-10 rounded px-2 text-[12px] text-muted hover:bg-canvas hover:text-ink disabled:opacity-50 md:min-h-7"

function dateText(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

// "Lessons (n)": opens the list of what the Director taught a persona. It is
// the entry in the members panel and on the Organization page.
export function LessonsButton({ persona, className }: { persona: string; className?: string }) {
  const lessons = useLessons()
  const [open, setOpen] = useState(false)
  const count = (lessons.data ?? []).filter((item) => item.persona === persona).length
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} aria-label={`Lessons for @${persona}`} className={className}>
        Lessons ({count})
      </button>
      {open && <LessonsDialog persona={persona} open onOpenChange={setOpen} />}
    </>
  )
}

// What the Director taught one persona, newest first. Editing is in place. A
// delete waits five seconds with an Undo before the DELETE is sent; closing the
// panel sends the waiting deletes at once.
export function LessonsDialog({ persona, open, onOpenChange }: { persona: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const qc = useQueryClient()
  const me = useMe()
  const lessons = useLessons()
  const channels = useChannels()
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState("")
  const [waiting, setWaiting] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const isHuman = me.data?.kind !== "agent"

  const list = (lessons.data ?? [])
    .filter((item) => item.persona === persona)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
  const scopeOf = (lesson: Lesson) =>
    lesson.channel_id === "" ? "Everywhere" : `#${channels.data?.find((item) => item.id === lesson.channel_id)?.name ?? "a channel"}`

  async function send(id: string) {
    timers.current.delete(id)
    try {
      await api.deleteLesson(id)
      qc.setQueryData<Lesson[] | undefined>(qk.lessons, (current) => current?.filter((item) => item.id !== id))
    } catch {
      setError("Could not delete the lesson.")
    }
    setWaiting((current) => current.filter((item) => item !== id))
  }

  function remove(id: string) {
    setError(null)
    setWaiting((current) => [...current, id])
    timers.current.set(id, setTimeout(() => void send(id), UNDO_MS))
  }

  function undo(id: string) {
    clearTimeout(timers.current.get(id))
    timers.current.delete(id)
    setWaiting((current) => current.filter((item) => item !== id))
  }

  useEffect(() => {
    const pending = timers.current
    return () => {
      for (const [id, timer] of pending) {
        clearTimeout(timer)
        void api.deleteLesson(id).then(
          () => qc.setQueryData<Lesson[] | undefined>(qk.lessons, (current) => current?.filter((item) => item.id !== id)),
          () => undefined,
        )
      }
      pending.clear()
    }
  }, [qc])

  async function save(lesson: Lesson) {
    const text = draft.trim()
    if (text === "" || [...text].length > LESSON_MAX) return
    if (text === lesson.text) {
      setEditing(null)
      return
    }
    setError(null)
    try {
      const next = await api.patchLesson(lesson.id, { text })
      qc.setQueryData<Lesson[] | undefined>(qk.lessons, (current) => (current ? replaceById(current, next) : current))
      setEditing(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the lesson.")
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/40" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-[10vh] z-50 flex max-h-[80vh] w-[min(32rem,calc(100vw-1.5rem))] -translate-x-1/2 flex-col overflow-hidden rounded-lg border border-line bg-surface shadow-lg"
        >
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <Dialog.Title className="truncate text-[14px] font-semibold">Lessons for @{persona}</Dialog.Title>
            <Dialog.Close className="min-h-10 rounded px-2 text-[13px] text-muted hover:text-ink md:min-h-8">Close</Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {error && (
              <p role="alert" className="px-4 pt-2 text-[13px] text-danger">
                {error}
              </p>
            )}
            {lessons.isPending ? (
              <p className="px-4 py-4 text-[13px] text-muted">Loading</p>
            ) : list.length === 0 ? (
              <p className="px-4 py-4 text-[13px] text-muted">
                A lesson is a short correction you teach @{persona}; every later run of that agent sees it. Use Teach on one of its answers to add one.
              </p>
            ) : (
              <ul className="divide-y divide-line" aria-label="Lessons">
                {list.map((lesson) =>
                  waiting.includes(lesson.id) ? (
                    <li key={lesson.id} className="flex items-center gap-2 px-4 py-2 text-[13px]" data-lesson={lesson.id}>
                      <span role="status" className="min-w-0 flex-1 text-muted">
                        Lesson deleted.
                      </span>
                      <button type="button" onClick={() => undo(lesson.id)} className="min-h-10 rounded px-2 text-[13px] font-medium text-accent hover:underline md:min-h-8">
                        Undo
                      </button>
                    </li>
                  ) : (
                    <li key={lesson.id} className="px-4 py-2" data-lesson={lesson.id}>
                      {editing === lesson.id ? (
                        <form
                          className="space-y-2"
                          onSubmit={(event) => {
                            event.preventDefault()
                            void save(lesson)
                          }}
                        >
                          <input
                            autoFocus
                            aria-label="Lesson text"
                            value={draft}
                            onChange={(event) => setDraft(event.target.value)}
                            onKeyDown={(event) => {
                              // Escape ends the edit, not the whole panel.
                              if (event.key === "Escape") {
                                event.stopPropagation()
                                setEditing(null)
                              }
                            }}
                            className={FIELD}
                          />
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-[11px] text-faint">
                              {[...draft].length}/{LESSON_MAX}
                            </span>
                            <span className="flex-1" />
                            <button type="button" onClick={() => setEditing(null)} className={SMALL}>
                              Cancel
                            </button>
                            <button
                              type="submit"
                              disabled={draft.trim() === "" || [...draft].length > LESSON_MAX}
                              className="min-h-10 rounded bg-accent px-3 text-[13px] font-medium text-white disabled:opacity-50 md:min-h-8"
                            >
                              Save
                            </button>
                          </div>
                        </form>
                      ) : (
                        <>
                          <p className="break-words text-[13px]">{lesson.text}</p>
                          <p className="flex flex-wrap items-center gap-x-2 text-[12px] text-muted">
                            <span>{scopeOf(lesson)}</span>
                            <span className="text-faint">{dateText(lesson.created_at)}</span>
                            {isHuman && (
                              <>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setError(null)
                                    setDraft(lesson.text)
                                    setEditing(lesson.id)
                                  }}
                                  className={SMALL}
                                >
                                  Edit
                                </button>
                                <button type="button" onClick={() => remove(lesson.id)} className={SMALL}>
                                  Delete
                                </button>
                              </>
                            )}
                          </p>
                        </>
                      )}
                    </li>
                  ),
                )}
              </ul>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

import { useEffect, useId, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react"
import { ApiError, api } from "../api/client"
import { formatSize } from "../lib/files"
import { appendDictation } from "../lib/dictation"
import { applyMention, filterMembers, mentionQuery } from "../lib/mentions"
import { parseTaskCommand } from "../lib/tasks"
import type { Attachment, Member } from "../types"
import { DictationButton } from "./dictation-button"

interface Upload {
  key: string
  name: string
  size: number
  attachment?: Attachment
  error?: string
}

function uploadError(error: unknown): string {
  if (error instanceof ApiError) return error.message
  return "Upload failed"
}

const DRAFT_PREFIX = "faztudo.draft."

// A keystroke schedules the write; a long paste is not written on every key.
const DRAFT_DELAY_MS = 300

/** The unsent text kept for a composer, per browser. */
export function readDraft(key: string | undefined): string {
  if (!key) return ""
  try {
    return localStorage.getItem(DRAFT_PREFIX + key) ?? ""
  } catch {
    return ""
  }
}

export function writeDraft(key: string | undefined, text: string): void {
  if (!key) return
  try {
    if (text) localStorage.setItem(DRAFT_PREFIX + key, text)
    else localStorage.removeItem(DRAFT_PREFIX + key)
  } catch {
    // Private mode or a full store: the draft lasts until the page closes.
  }
}

// Focusing on a phone would raise the keyboard over the channel.
function hasPointer(): boolean {
  return typeof matchMedia === "function" && matchMedia("(hover: hover) and (pointer: fine)").matches
}

export function Composer({
  members,
  channelName,
  placeholder,
  label = "Message",
  attach = false,
  draftKey,
  autoFocus = false,
  onSend,
  onTask,
}: {
  members: Member[]
  channelName: string
  placeholder?: string
  label?: string
  /** Show the attach button and accept pasted or dropped files. */
  attach?: boolean
  /**
   * Keeps unsent text in local storage under this key and restores it when
   * the composer mounts, so key the composer by the channel or thread.
   */
  draftKey?: string
  /** Focus the box on mount, on devices with a pointer only. */
  autoFocus?: boolean
  onSend: (body: string, attachments?: Attachment[]) => void
  /** Opens the task builder, with a title. Adds the Task button and the /task command. */
  onTask?: (title: string) => void
}) {
  const listId = useId()
  const [text, setText] = useState(() => readDraft(draftKey))
  const [uploads, setUploads] = useState<Upload[]>([])
  const fileInput = useRef<HTMLInputElement>(null)
  const counter = useRef(0)
  const uploading = uploads.some((item) => !item.attachment && !item.error)
  const ready = uploads.flatMap((item) => (item.attachment ? [item.attachment] : []))
  const [cursor, setCursor] = useState(0)
  const [active, setActive] = useState(0)
  const [suppressed, setSuppressed] = useState<string | null>(null)
  const boxRef = useRef<HTMLTextAreaElement>(null)
  const pendingCursor = useRef<number | null>(null)
  const draft = useRef({ key: draftKey, text })
  const query = mentionQuery(text, cursor)
  const matches = query ? filterMembers(members, query.query) : []
  const queryKey = query ? `${query.start}:${query.query}` : null
  const menuOpen = Boolean(query && matches.length > 0 && suppressed !== queryKey)
  const selected = matches[Math.min(active, Math.max(0, matches.length - 1))]
  const canSend = !uploading && (text.trim().length > 0 || ready.length > 0)

  useLayoutEffect(() => {
    const el = boxRef.current
    const next = pendingCursor.current
    if (!el || next === null) return
    pendingCursor.current = null
    el.setSelectionRange(next, next)
  }, [text])

  // Grow with the text up to about eight lines, then scroll.
  useLayoutEffect(() => {
    const el = boxRef.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`
  }, [text])

  useEffect(() => {
    draft.current = { key: draftKey, text }
    const timer = setTimeout(() => writeDraft(draftKey, text), DRAFT_DELAY_MS)
    return () => clearTimeout(timer)
  }, [draftKey, text])

  // Leaving the channel or the page flushes what the timer has not written.
  useEffect(() => {
    function flush() {
      writeDraft(draft.current.key, draft.current.text)
    }
    window.addEventListener("pagehide", flush)
    return () => {
      window.removeEventListener("pagehide", flush)
      flush()
    }
  }, [])

  useEffect(() => {
    const el = boxRef.current
    if (!autoFocus || !el || !hasPointer()) return
    el.focus()
    const end = el.value.length
    el.setSelectionRange(end, end)
    setCursor(end)
  }, [autoFocus])

  // The arrow keys can move the choice past the visible part of the list.
  useEffect(() => {
    if (!menuOpen || !selected) return
    document.getElementById(`${listId}-${selected.id}`)?.scrollIntoView({ block: "nearest" })
  }, [listId, menuOpen, selected])

  function sync(target: HTMLTextAreaElement) {
    setCursor(target.selectionStart ?? target.value.length)
  }

  function pick(member: Member) {
    const next = applyMention(text, cursor, member.handle)
    pendingCursor.current = next.cursor
    setText(next.text)
    setCursor(next.cursor)
    setActive(0)
    setSuppressed(null)
  }

  function addFiles(list: FileList | File[] | null | undefined) {
    if (!attach || !list) return
    for (const file of Array.from(list)) {
      const key = `u${++counter.current}`
      setUploads((current) => [...current, { key, name: file.name, size: file.size }])
      api.uploadFile(file).then(
        (attachment) => setUploads((current) => current.map((item) => (item.key === key ? { ...item, attachment } : item))),
        (error: unknown) => setUploads((current) => current.map((item) => (item.key === key ? { ...item, error: uploadError(error) } : item))),
      )
    }
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    if (!attach || event.clipboardData.files.length === 0) return
    event.preventDefault()
    addFiles(event.clipboardData.files)
  }

  function onDrop(event: DragEvent<HTMLElement>) {
    if (!attach || event.dataTransfer.files.length === 0) return
    event.preventDefault()
    addFiles(event.dataTransfer.files)
  }

  function send() {
    if (menuOpen && selected) {
      pick(selected)
      return
    }
    const body = text.trim()
    const command = onTask ? parseTaskCommand(body) : null
    if (command && onTask) {
      onTask(command.title)
      clear()
      return
    }
    if (!canSend) return
    if (ready.length > 0) onSend(body, ready)
    else onSend(body)
    clear()
    setUploads((current) => current.filter((item) => item.error))
  }

  // The draft goes at once, not on the timer, so a reload cannot bring a
  // sent message back.
  function clear() {
    setText("")
    setCursor(0)
    writeDraft(draftKey, "")
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // 229 is the key code browsers report while an IME is composing; some
    // leave isComposing false on the Enter that confirms the text.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (menuOpen && selected) {
      if (event.key === "ArrowDown") {
        event.preventDefault()
        setActive((index) => (index + 1) % matches.length)
        return
      }
      if (event.key === "ArrowUp") {
        event.preventDefault()
        setActive((index) => (index - 1 + matches.length) % matches.length)
        return
      }
      if (event.key === "Escape") {
        event.preventDefault()
        setSuppressed(queryKey)
        return
      }
      if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
        event.preventDefault()
        pick(selected)
        return
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      send()
    }
  }

  return (
    <form
      className="shrink-0 px-3 pb-3 pt-2 md:bg-surface md:px-4"
      onSubmit={(event) => {
        event.preventDefault()
        send()
      }}
      onDragOver={(event) => {
        if (attach && event.dataTransfer.types.includes("Files")) event.preventDefault()
      }}
      onDrop={onDrop}
    >
      <div className="relative">
        {menuOpen && (
          <ul
            id={listId}
            role="listbox"
            aria-label="Members"
            className="absolute bottom-full left-0 z-20 mb-1 max-h-56 w-full max-w-sm overflow-auto rounded-md border border-line bg-surface py-1 shadow-lg"
          >
            {matches.map((member, index) => (
              <li key={member.id} role="presentation">
                <button
                  type="button"
                  role="option"
                  aria-selected={member.id === selected?.id}
                  id={`${listId}-${member.id}`}
                  className="flex min-h-10 w-full items-baseline gap-2 px-2 py-1.5 text-left text-[13px] aria-selected:bg-accent-soft md:min-h-8"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => pick(member)}
                  onMouseEnter={() => setActive(index)}
                >
                  <span className="font-medium">{member.display_name}</span>
                  <span className="text-muted">@{member.handle}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {uploads.length > 0 && (
          <ul className="mb-1.5 flex flex-wrap gap-1.5 px-1" aria-label="Files to send">
            {uploads.map((item) => (
              <li
                key={item.key}
                className={`flex min-h-8 max-w-56 items-center gap-1.5 rounded-full border px-2.5 text-[12px] ${item.error ? "border-danger text-danger" : "border-line bg-surface text-ink"}`}
              >
                <span className="truncate">{item.name}</span>
                <span className="shrink-0 text-faint">
                  {item.error ?? (item.attachment ? formatSize(item.size) : "Uploading")}
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${item.name}`}
                  onClick={() => setUploads((current) => current.filter((entry) => entry.key !== item.key))}
                  className="-mr-1.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted transition-colors duration-150 hover:bg-sidebar hover:text-ink"
                >
                  <span aria-hidden="true">x</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-end gap-2 rounded-2xl border border-line bg-surface p-1.5 pl-3 transition-colors duration-150 focus-within:border-accent max-md:rounded-3xl max-md:pl-1.5 max-md:shadow-lg md:bg-canvas">
        {attach && (
          <>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              data-testid="file-input"
              onChange={(event) => {
                addFiles(event.target.files)
                event.target.value = ""
              }}
            />
            <button
              type="button"
              aria-label="Attach a file"
              title="Attach a file"
              onClick={() => fileInput.current?.click()}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-muted transition-colors duration-150 hover:bg-sidebar hover:text-ink md:h-8 md:w-8"
            >
              <svg viewBox="0 0 20 20" className="h-[18px] w-[18px]" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M16 9.5 9.6 15.9a3.7 3.7 0 0 1-5.2-5.2l7-7a2.5 2.5 0 0 1 3.5 3.5l-7 7a1.2 1.2 0 0 1-1.7-1.7l6.3-6.3" />
              </svg>
            </button>
          </>
        )}
        {onTask && (
          <button
            type="button"
            aria-label="New task"
            title="New task (or type /task)"
            onClick={() => onTask("")}
            className="flex h-10 shrink-0 items-center justify-center rounded-full px-2.5 text-[12px] font-medium text-muted transition-colors duration-150 hover:bg-sidebar hover:text-ink md:h-8"
          >
            Task
          </button>
        )}
        <label className="block min-w-0 flex-1">
          <span className="sr-only">{label}</span>
          <textarea
            ref={boxRef}
            value={text}
            rows={1}
            placeholder={placeholder ?? `Message #${channelName}`}
            aria-label={label}
            aria-autocomplete="list"
            aria-expanded={menuOpen}
            aria-controls={menuOpen ? listId : undefined}
            aria-activedescendant={menuOpen && selected ? `${listId}-${selected.id}` : undefined}
            className="block max-h-[180px] min-h-10 w-full resize-none bg-transparent py-2 text-[16px] leading-6 text-ink outline-none placeholder:text-faint focus-visible:outline-none md:min-h-8 md:py-1.5 md:text-[14px] md:leading-5"
            onChange={(event) => {
              setText(event.target.value)
              sync(event.target)
              setActive(0)
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onKeyUp={(event) => sync(event.currentTarget)}
            onClick={(event) => sync(event.currentTarget)}
            onSelect={(event) => sync(event.currentTarget)}
          />
        </label>
        <DictationButton onText={(words) => setText((current) => appendDictation(current, words))} />
        <button
          type="submit"
          aria-label="Send"
          disabled={!canSend}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent text-canvas transition-opacity duration-150 hover:opacity-90 disabled:opacity-40 disabled:hover:opacity-40 md:h-8 md:w-auto md:rounded-lg md:px-3 md:text-[13px]"
        >
          <svg viewBox="0 0 20 20" className="h-4 w-4 md:hidden" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10 16V4M5 9l5-5 5 5" />
          </svg>
          <span className="hidden md:inline" aria-hidden="true">
            Send
          </span>
        </button>
        </div>
      </div>
      <p className="mt-1 hidden px-3 text-[11px] text-faint md:block">Enter to send, Shift+Enter for a new line</p>
    </form>
  )
}

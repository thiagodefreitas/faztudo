import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react"
import { ApiError, api } from "../api/client"
import { formatSize } from "../lib/files"
import { appendDictation } from "../lib/dictation"
import { applyMention, filterMembers, mentionHandles, mentionQuery } from "../lib/mentions"
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
const COMMANDS = [
  { name: "/status", description: "Show active runs and lane status" },
  { name: "/lane", description: "Set an agent's preferred lane here" },
  { name: "/task", description: "Open the task builder" },
] as const

function usePhoneWidth(): boolean {
  return useSyncExternalStore(
    (listen) => { window.addEventListener("resize", listen); return () => window.removeEventListener("resize", listen) },
    () => window.innerWidth < 420,
    () => false,
  )
}

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
  suggestion,
  onSend,
  onTask,
  memberIds,
  onAddMember,
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
  suggestion?: { id: number; text: string }
  onSend: (body: string, attachments?: Attachment[]) => void
  /** Opens the task builder, with a title. Adds the Task button and the /task command. */
  onTask?: (title: string) => void
  memberIds?: string[]
  onAddMember?: (member: Member) => Promise<void>
}) {
  const listId = useId()
  const [text, setText] = useState(() => readDraft(draftKey))
  const [seenSuggestion, setSeenSuggestion] = useState(suggestion?.id)
  const [uploads, setUploads] = useState<Upload[]>([])
  const fileInput = useRef<HTMLInputElement>(null)
  const counter = useRef(0)
  const uploading = uploads.some((item) => !item.attachment && !item.error)
  const ready = uploads.flatMap((item) => (item.attachment ? [item.attachment] : []))
  const [cursor, setCursor] = useState(0)
  const [active, setActive] = useState(0)
  const [suppressed, setSuppressed] = useState<string | null>(null)
  const [addError, setAddError] = useState("")
  const [addingId, setAddingId] = useState<string | null>(null)
  const phone = usePhoneWidth()
  const boxRef = useRef<HTMLTextAreaElement>(null)
  const pendingCursor = useRef<number | null>(null)
  const draft = useRef({ key: draftKey, text })
  const query = mentionQuery(text, cursor)
  const matches = query ? filterMembers(members, query.query) : []
  const slash = /^\/([a-z]*)$/i.exec(text.slice(0, cursor))
  const commands = slash ? COMMANDS.filter((command) => (onTask || command.name !== "/task") && command.name.startsWith(`/${slash[1]?.toLowerCase() ?? ""}`)) : []
  const commandMenu = Boolean(slash && commands.length > 0)
  const queryKey = query ? `${query.start}:${query.query}` : commandMenu ? `slash:${slash?.[1] ?? ""}` : null
  const menuOpen = Boolean((query && matches.length > 0 || commandMenu) && suppressed !== queryKey)
  const selected = commandMenu ? commands[Math.min(active, commands.length - 1)] : matches[Math.min(active, Math.max(0, matches.length - 1))]
  const missingAgents = memberIds && !/^\/lane(?:\s|$)/i.test(text.trimStart()) ? [...new Set(mentionHandles(text))].map((handle) => members.find((member) => member.kind === "agent" && member.handle.toLowerCase() === handle)).filter((member): member is Member => !!member && !memberIds.includes(member.id)) : []
  const canSend = !uploading && (text.trim().length > 0 || ready.length > 0)
  const taskMode = !!onTask && /^\/task(?:\s|$)/i.test(text.trimStart())

  if (suggestion && suggestion.id !== seenSuggestion) {
    const nextText = text.trim() ? `${text}${/\s$/.test(text) ? "" : " "}${suggestion.text}` : suggestion.text
    setSeenSuggestion(suggestion.id)
    setText(nextText)
    setCursor(nextText.length)
  }

  useLayoutEffect(() => {
    const el = boxRef.current
    const next = pendingCursor.current
    if (!el || next === null) return
    pendingCursor.current = null
    el.setSelectionRange(next, next)
  }, [text])

  // Grow with the text up to about ten lines, then scroll.
  useLayoutEffect(() => {
    const el = boxRef.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
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

  useEffect(() => {
    if (suggestion) {
      boxRef.current?.focus()
      const end = boxRef.current?.value.length ?? 0
      boxRef.current?.setSelectionRange(end, end)
    }
  }, [suggestion])

  // The arrow keys can move the choice past the visible part of the list.
  useEffect(() => {
    if (!menuOpen || !selected) return
    document.getElementById(`${listId}-${"id" in selected ? selected.id : selected.name}`)?.scrollIntoView({ block: "nearest" })
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

  function pickCommand(name: string) {
    const next = `${name} ` + text.slice(cursor)
    pendingCursor.current = name.length + 1
    setText(next)
    setCursor(name.length + 1)
    setActive(0)
    setSuppressed(null)
  }

  function pickSelected() {
    if (!selected) return
    if ("name" in selected) pickCommand(selected.name)
    else pick(selected)
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
      pickSelected()
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
        setActive((index) => (index + 1) % (commandMenu ? commands.length : matches.length))
        return
      }
      if (event.key === "ArrowUp") {
        event.preventDefault()
        setActive((index) => (index - 1 + (commandMenu ? commands.length : matches.length)) % (commandMenu ? commands.length : matches.length))
        return
      }
      if (event.key === "Escape") {
        event.preventDefault()
        setSuppressed(queryKey)
        return
      }
      if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
        event.preventDefault()
        pickSelected()
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
            aria-label={commandMenu ? "Commands" : "Members"}
            className="absolute bottom-full left-0 z-20 mb-1 max-h-56 w-full max-w-sm overflow-auto rounded-md border border-line bg-surface py-1 shadow-lg"
          >
            {(commandMenu ? commands : matches).map((item, index) => (
              <li key={"name" in item ? item.name : item.id} role="presentation">
                <button
                  type="button"
                  role="option"
                  aria-selected={item === selected}
                  id={`${listId}-${"name" in item ? item.name : item.id}`}
                  className="flex min-h-10 w-full items-baseline gap-2 px-2 py-1.5 text-left text-[13px] aria-selected:bg-accent-soft md:min-h-8"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => { if ("name" in item) pickCommand(item.name); else pick(item) }}
                  onMouseEnter={() => setActive(index)}
                >
                  {"name" in item ? <><span className="font-medium">{item.name}</span><span className="text-muted">{item.description}</span></> : <><span className="font-medium">{item.display_name}</span><span className="text-muted">@{item.handle}</span></>}
                </button>
              </li>
            ))}
            {!commandMenu && selected && "id" in selected && selected.agent?.mode === "write" && <li className="border-t border-line px-2 py-1.5 text-[11px] text-muted">Add x2 after @{selected.handle} to compare two lanes.</li>}
          </ul>
        )}
        {missingAgents.length > 0 && <div className="mb-2 rounded-md border border-warn bg-warn-soft px-2.5 py-2 text-[12px] text-ink" role="status">
          {missingAgents.map((member) => <div key={member.id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>@{member.handle} is not in this channel. The mention can start a run.</span>
            {onAddMember && <button type="button" disabled={addingId !== null} className="font-medium text-accent underline disabled:opacity-50" onClick={() => { setAddingId(member.id); setAddError(""); void onAddMember(member).catch((error: unknown) => setAddError(error instanceof Error ? error.message : "Could not add agent")).finally(() => setAddingId(null)) }}>Add @{member.handle} to this channel</button>}
          </div>)}
          {addError && <p role="alert" className="mt-1 text-danger">{addError}</p>}
        </div>}
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
        {taskMode && <span className="mb-1 ml-2 inline-flex rounded-md bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent">New task</span>}
        <div className={`flex items-end gap-1 rounded-2xl border bg-surface p-1.5 pl-2 transition-colors duration-150 focus-within:border-accent max-[420px]:flex-wrap max-md:rounded-3xl max-md:shadow-sm md:bg-canvas ${taskMode ? "border-accent" : "border-line"}`}>
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
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-muted transition-colors duration-150 hover:bg-sidebar hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent md:h-8 md:w-8"
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
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-muted transition-colors duration-150 hover:bg-sidebar hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent md:h-8 md:w-8"
          >
            <svg viewBox="0 0 20 20" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="4" y="4" width="12" height="12" rx="2" /><path d="M7 10h6M10 7v6" /></svg>
          </button>
        )}
        <label className="block min-w-0 flex-1 max-[420px]:order-first max-[420px]:basis-full">
          <span className="sr-only">{label}</span>
          <textarea
            ref={boxRef}
            value={text}
            rows={1}
            placeholder={phone ? "Message" : placeholder ?? `Message #${channelName}`}
            aria-label={label}
            aria-autocomplete="list"
            aria-expanded={menuOpen}
            aria-controls={menuOpen ? listId : undefined}
            aria-activedescendant={menuOpen && selected ? `${listId}-${"name" in selected ? selected.name : selected.id}` : undefined}
            className="block max-h-[240px] min-h-10 w-full resize-none bg-transparent py-2 text-[16px] leading-6 text-ink outline-none placeholder:text-faint focus-visible:outline-none md:min-h-8 md:py-1.5 md:text-[14px] md:leading-5"
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
          title={taskMode ? "Create task" : "Send message"}
          disabled={!canSend}
          className="ml-auto flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent text-canvas transition-opacity duration-150 hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:bg-sidebar disabled:text-faint disabled:opacity-100 md:h-8 md:w-auto md:px-3 md:text-[13px]"
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
      <p className="mt-1 truncate px-2 text-[11px] text-faint">{taskMode ? "Enter to open the task builder" : text.trim() ? "Enter to send, Shift+Enter for a new line" : "Type @ to mention someone or /task to create a task"}</p>
    </form>
  )
}

import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react"
import { applyMention, filterMembers, mentionQuery } from "../lib/mentions"
import type { Member } from "../types"

export function Composer({
  members,
  channelName,
  placeholder,
  label = "Message",
  onSend,
}: {
  members: Member[]
  channelName: string
  placeholder?: string
  label?: string
  onSend: (body: string) => void
}) {
  const listId = useId()
  const [text, setText] = useState("")
  const [cursor, setCursor] = useState(0)
  const [active, setActive] = useState(0)
  const [suppressed, setSuppressed] = useState<string | null>(null)
  const boxRef = useRef<HTMLTextAreaElement>(null)
  const pendingCursor = useRef<number | null>(null)
  const query = mentionQuery(text, cursor)
  const matches = query ? filterMembers(members, query.query) : []
  const queryKey = query ? `${query.start}:${query.query}` : null
  const menuOpen = Boolean(query && matches.length > 0 && suppressed !== queryKey)
  const selected = matches[Math.min(active, Math.max(0, matches.length - 1))]

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

  function send() {
    if (menuOpen && selected) {
      pick(selected)
      return
    }
    const body = text.trim()
    if (!body) return
    onSend(body)
    setText("")
    setCursor(0)
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing) return
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
                  className="flex w-full items-baseline gap-2 px-2 py-1.5 text-left text-[13px] aria-selected:bg-accent-soft"
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
        <div className="flex items-end gap-2 rounded-2xl border border-line bg-surface p-1.5 pl-3 transition-colors duration-150 focus-within:border-accent max-md:rounded-3xl max-md:pl-1.5 max-md:shadow-lg md:bg-canvas">
        <button
          type="button"
          disabled
          aria-label="Attachments soon"
          title="Attachments soon"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-faint md:hidden"
        >
          <svg viewBox="0 0 20 20" className="h-[18px] w-[18px]" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M10 4v12M4 10h12" />
          </svg>
        </button>
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
            onKeyUp={(event) => sync(event.currentTarget)}
            onClick={(event) => sync(event.currentTarget)}
            onSelect={(event) => sync(event.currentTarget)}
          />
        </label>
        <button
          type="submit"
          aria-label="Send"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent text-canvas transition-opacity duration-150 hover:opacity-90 md:h-8 md:w-auto md:rounded-lg md:px-3 md:text-[13px]"
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

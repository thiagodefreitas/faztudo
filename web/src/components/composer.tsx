import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react"
import { applyMention, filterMembers, mentionQuery } from "../lib/mentions"
import type { Member } from "../types"

export function Composer({
  members,
  channelName,
  onSend,
}: {
  members: Member[]
  channelName: string
  onSend: (body: string) => void
}) {
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
      className="border-t border-line bg-surface px-3 py-2"
      onSubmit={(event) => {
        event.preventDefault()
        send()
      }}
    >
      <div className="relative">
        {menuOpen && (
          <ul
            id="mention-list"
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
                  id={`mention-${member.id}`}
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
        <label className="block">
          <span className="sr-only">Message</span>
          <textarea
            ref={boxRef}
            value={text}
            rows={2}
            placeholder={`Message #${channelName}`}
            aria-label="Message"
            aria-autocomplete="list"
            aria-expanded={menuOpen}
            aria-controls={menuOpen ? "mention-list" : undefined}
            aria-activedescendant={menuOpen && selected ? `mention-${selected.id}` : undefined}
            className="w-full resize-none rounded-md border border-line bg-canvas px-3 py-2 text-[16px] leading-5 text-ink outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent md:text-[14px]"
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
      </div>
      <div className="mt-1 flex items-center justify-between gap-3">
        <p className="hidden text-[12px] text-faint md:block">Enter to send, Shift+Enter for a new line</p>
        <button type="submit" className="ml-auto min-h-9 rounded-md bg-accent px-3 text-[13px] text-canvas">
          Send
        </button>
      </div>
    </form>
  )
}

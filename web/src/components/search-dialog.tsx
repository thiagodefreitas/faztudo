import * as Dialog from "@radix-ui/react-dialog"
import { useNavigate, useRouterState } from "@tanstack/react-router"
import { useEffect, useRef, useState, type KeyboardEvent } from "react"
import { api } from "../api/client"
import { plainPreview } from "../lib/inbox"
import { splitSnippet } from "../lib/snippet"
import { formatClock } from "../lib/time"
import { useChannels, useMembers } from "../state/queries"
import type { SearchHit } from "../types"

// The command palette and the channel header ask the dialog to open.
export const OPEN_SEARCH_EVENT = "faztudo:open-search"

type Status = "idle" | "loading" | "done" | "error"

export function SearchDialog() {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState("")
  const [thisChannel, setThisChannel] = useState(false)
  const [hits, setHits] = useState<SearchHit[]>([])
  const [status, setStatus] = useState<Status>("idle")
  const [active, setActive] = useState(0)
  const navigate = useNavigate()
  const channels = useChannels()
  const members = useMembers()
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const channelId = /^\/c\/([^/]+)/.exec(pathname)?.[1]
  const latest = useRef(0)

  useEffect(() => {
    function onOpen() {
      setOpen(true)
    }
    function onKey(event: globalThis.KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "f") {
        event.preventDefault()
        setOpen(true)
      }
    }
    window.addEventListener(OPEN_SEARCH_EVENT, onOpen)
    window.addEventListener("keydown", onKey)
    return () => {
      window.removeEventListener(OPEN_SEARCH_EVENT, onOpen)
      window.removeEventListener("keydown", onKey)
    }
  }, [])

  const scope = thisChannel && channelId ? channelId : undefined
  useEffect(() => {
    if (!open) return
    const trimmed = q.trim()
    const ticket = ++latest.current
    if (!trimmed) return
    const timer = window.setTimeout(() => {
      api.search({ q: trimmed, ...(scope ? { channel_id: scope } : {}) }).then(
        (found) => {
          if (ticket !== latest.current) return
          setHits(found)
          setActive(0)
          setStatus("done")
        },
        () => {
          if (ticket === latest.current) setStatus("error")
        },
      )
    }, 200)
    return () => window.clearTimeout(timer)
  }, [q, scope, open])

  // A new query shows "Searching" at once; the effect above fetches after a pause.
  function change(value: string, onlyHere = thisChannel) {
    setQ(value)
    setThisChannel(onlyHere)
    if (value.trim()) {
      setStatus("loading")
    } else {
      setStatus("idle")
      setHits([])
    }
  }

  function go(hit: SearchHit) {
    setOpen(false)
    const target = hit.message.channel_id
    // A reply lives in its thread panel; anything else is found in the transcript.
    const search = hit.message.thread_id ? { thread: hit.message.thread_id } : { m: hit.message.id }
    void navigate({ to: "/c/$channelId", params: { channelId: target }, search })
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" && hits.length > 0) {
      event.preventDefault()
      setActive((index) => (index + 1) % hits.length)
    } else if (event.key === "ArrowUp" && hits.length > 0) {
      event.preventDefault()
      setActive((index) => (index - 1 + hits.length) % hits.length)
    } else if (event.key === "Enter") {
      const hit = hits[active]
      if (hit) {
        event.preventDefault()
        go(hit)
      }
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/40" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-[10vh] z-50 flex max-h-[80vh] w-[min(40rem,calc(100vw-1.5rem))] -translate-x-1/2 flex-col overflow-hidden rounded-lg border border-line bg-surface shadow-lg"
        >
          <Dialog.Title className="sr-only">Search messages</Dialog.Title>
          <input
            autoFocus
            value={q}
            onChange={(event) => change(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search messages"
            aria-label="Search messages"
            className="min-h-11 w-full border-b border-line bg-surface px-3 text-[16px] text-ink outline-none md:text-[14px]"
          />
          {channelId && (
            <label className="flex min-h-10 items-center gap-2 border-b border-line px-3 text-[12px] text-muted">
              <input type="checkbox" checked={thisChannel} onChange={(event) => change(q, event.target.checked)} className="h-4 w-4 accent-accent" />
              Only this channel
            </label>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto p-1" aria-live="polite">
            {status === "idle" && <p className="px-3 py-4 text-[13px] text-muted">Type to search every message you can read.</p>}
            {status === "loading" && hits.length === 0 && <p className="px-3 py-4 text-[13px] text-muted">Searching</p>}
            {status === "error" && <p className="px-3 py-4 text-[13px] text-danger">Search failed. Try again.</p>}
            {status === "done" && hits.length === 0 && <p className="px-3 py-4 text-[13px] text-muted">No messages match.</p>}
            <ul role="listbox" aria-label="Results">
              {hits.map((hit, index) => {
                const channel = channels.data?.find((item) => item.id === hit.message.channel_id)
                const author = members.data?.find((item) => item.id === hit.message.author_id)
                return (
                  <li key={hit.message.id} role="presentation">
                    <button
                      type="button"
                      role="option"
                      aria-selected={index === active}
                      onMouseEnter={() => setActive(index)}
                      onClick={() => go(hit)}
                      className="block min-h-10 w-full rounded px-3 py-2 text-left aria-selected:bg-accent-soft"
                    >
                      <span className="flex items-baseline gap-2 text-[12px] text-muted">
                        <span className="font-medium text-ink">{channel ? `#${channel.name}` : "channel"}</span>
                        <span>{author?.display_name ?? "Member"}</span>
                        {hit.message.thread_id && <span>in a thread</span>}
                        <time className="ml-auto font-mono text-faint" dateTime={hit.message.created_at}>
                          {formatClock(hit.message.created_at)}
                        </time>
                      </span>
                      <span className="mt-0.5 block text-[13px] text-ink">
                        {(hit.snippet ? splitSnippet(hit.snippet) : [{ text: plainPreview(hit.message.body), hit: false }]).map((part, i) =>
                          part.hit ? (
                            <mark key={i} className="rounded-sm bg-accent-soft px-0.5 text-ink">
                              {part.text}
                            </mark>
                          ) : (
                            <span key={i}>{part.text}</span>
                          ),
                        )}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

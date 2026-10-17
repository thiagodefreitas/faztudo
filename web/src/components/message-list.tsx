import { useVirtualizer } from "@tanstack/react-virtual"
import { useQueryClient } from "@tanstack/react-query"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { api } from "../api/client"
import { formatClock } from "../lib/time"
import { cx } from "../lib/cx"
import { qk } from "../state/keys"
import { mergeById } from "../state/merge"
import { sortMessages } from "../state/reduce"
import { useMe, useMembers, useMessages, useNotices, usePending, useRuns, type PendingMessage } from "../state/queries"
import type { Message, NoticeItem, Run } from "../types"
import { Markdown } from "./markdown"
import { RunCard } from "./run-card"

type Row =
  | { kind: "message"; key: string; at: string; message: Message }
  | { kind: "notice"; key: string; at: string; notice: NoticeItem }
  | { kind: "pending"; key: string; at: string; pending: PendingMessage }

export function MessageList({ channelId, onRetry }: { channelId: string; onRetry: (item: PendingMessage) => void }) {
  const qc = useQueryClient()
  const messagesQuery = useMessages(channelId)
  const members = useMembers()
  const me = useMe()
  const runs = useRuns()
  const notices = useNotices()
  const pending = usePending(channelId)
  const messages = messagesQuery.data ?? []
  const parentRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const stuckRef = useRef(true)
  const preserveRef = useRef<{ height: number; top: number } | null>(null)
  const [unstuck, setUnstuck] = useState(false)
  const [loadingEarlier, setLoadingEarlier] = useState(false)

  const visiblePending = (pending.data ?? []).filter((item) => {
    if (item.error) return true
    const mine = me.data?.id
    if (!mine) return true
    return !messages.some((message) => message.author_id === mine && message.body === item.body)
  })

  const rows: Row[] = [
    ...messages.map((message) => ({ kind: "message" as const, key: message.id, at: message.created_at, message })),
    ...(notices.data ?? [])
      .filter((notice) => notice.channel_id === channelId)
      .map((notice) => ({ kind: "notice" as const, key: notice.id, at: notice.ts, notice })),
    ...visiblePending.map((item) => ({ kind: "pending" as const, key: `pending:${item.key}`, at: item.createdAt, pending: item })),
  ].sort((a, b) => a.at.localeCompare(b.at) || a.key.localeCompare(b.key))

  // TanStack Virtual returns functions the React compiler cannot memoize.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 88,
    overscan: 8,
    getItemKey: (index) => rows[index]?.key ?? index,
    measureElement: (element) => element.getBoundingClientRect().height,
  })

  useEffect(() => {
    const parent = parentRef.current
    const inner = innerRef.current
    if (!parent || !inner) return
    const observer = new ResizeObserver(() => {
      if (!stuckRef.current) return
      parent.scrollTop = parent.scrollHeight
    })
    observer.observe(inner)
    return () => observer.disconnect()
  }, [channelId])

  useLayoutEffect(() => {
    const el = parentRef.current
    const prev = preserveRef.current
    if (!el || !prev) return
    el.scrollTop = prev.top + (el.scrollHeight - prev.height)
    preserveRef.current = null
  }, [messages.length])

  function onScroll() {
    const el = parentRef.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    const stuck = distance < 48
    stuckRef.current = stuck
    setUnstuck((current) => (current === !stuck ? current : !stuck))
  }

  function jumpLatest() {
    const el = parentRef.current
    stuckRef.current = true
    setUnstuck(false)
    if (el) el.scrollTop = el.scrollHeight
  }

  async function loadEarlier() {
    const oldest = messages[0]
    const el = parentRef.current
    if (!oldest || !el || loadingEarlier) return
    preserveRef.current = { height: el.scrollHeight, top: el.scrollTop }
    stuckRef.current = false
    setLoadingEarlier(true)
    try {
      const older = await api.messages(channelId, { before: oldest.id, limit: 50 })
      qc.setQueryData<Message[]>(qk.messages(channelId), (current = []) => sortMessages(mergeById(older, current)))
    } finally {
      setLoadingEarlier(false)
    }
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {messages.length >= 100 && (
        <div className="flex justify-center border-b border-line py-1">
          <button type="button" className="min-h-8 px-2 text-[12px] text-muted" onClick={() => void loadEarlier()}>
            {loadingEarlier ? "Loading" : "Load earlier"}
          </button>
        </div>
      )}
      <div
        ref={parentRef}
        data-testid="transcript"
        aria-label="Messages"
        className="min-h-0 flex-1 overflow-y-auto"
        onScroll={onScroll}
      >
        {messagesQuery.isPending ? (
          <p className="px-4 py-6 text-[13px] text-muted">Loading messages</p>
        ) : rows.length === 0 ? (
          <p className="px-4 py-6 text-[13px] text-muted">No messages yet.</p>
        ) : (
          <div ref={innerRef} className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index]
              if (!row) return null
              return (
                <div
                  key={row.key}
                  data-index={item.index}
                  ref={virtualizer.measureElement}
                  className="absolute left-0 top-0 w-full px-4 py-2"
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  {row.kind === "message" && (
                    <MessageRow
                      message={row.message}
                      channelId={channelId}
                      authorName={members.data?.find((member) => member.id === row.message.author_id)?.display_name ?? "Member"}
                      run={runs.data?.find((entry) => entry.id === row.message.run_id)}
                    />
                  )}
                  {row.kind === "notice" && <NoticeRow notice={row.notice} />}
                  {row.kind === "pending" && <PendingRow item={row.pending} onRetry={onRetry} />}
                </div>
              )
            })}
          </div>
        )}
      </div>
      {unstuck && (
        <button
          type="button"
          onClick={jumpLatest}
          className="absolute bottom-3 left-1/2 z-10 min-h-8 -translate-x-1/2 rounded-full border border-line bg-surface px-3 text-[12px] shadow"
        >
          Latest
        </button>
      )}
    </div>
  )
}

function MessageRow({
  message,
  channelId,
  authorName,
  run,
}: {
  message: Message
  channelId: string
  authorName: string
  run: Run | undefined
}) {
  return (
    <article>
      <header className="flex items-baseline gap-2">
        <p className="text-[13px] font-medium">{authorName}</p>
        <time className="font-mono text-[11px] text-faint" dateTime={message.created_at}>
          {formatClock(message.created_at)}
        </time>
        {message.edited_at && <span className="text-[11px] text-faint">edited</span>}
      </header>
      <div className="mt-1 text-[14px]">
        <Markdown text={message.body} />
      </div>
      {run && <RunCard run={run} channelId={channelId} />}
    </article>
  )
}

function NoticeRow({ notice }: { notice: NoticeItem }) {
  return (
    <p
      className={cx(
        "text-[12px]",
        notice.level === "error" && "text-danger",
        notice.level === "warn" && "text-warn",
        notice.level === "info" && "text-muted",
      )}
    >
      {notice.text}
    </p>
  )
}

function PendingRow({ item, onRetry }: { item: PendingMessage; onRetry: (item: PendingMessage) => void }) {
  return (
    <article className="text-[13px] text-muted">
      <Markdown text={item.body} />
      {item.error ? (
        <p className="mt-1 text-danger">
          {item.error}{" "}
          <button type="button" className="underline" onClick={() => onRetry(item)}>
            Retry send
          </button>
        </p>
      ) : (
        <p className="mt-1 text-[12px] text-faint">Sending</p>
      )}
    </article>
  )
}

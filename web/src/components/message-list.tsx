import { useVirtualizer } from "@tanstack/react-virtual"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { api } from "../api/client"
import { participants } from "../lib/agent-chat"
import { answeredChoice, choiceBody } from "../lib/choices"
import { ulid } from "../lib/id"
import { formatClock } from "../lib/time"
import { cx } from "../lib/cx"
import { noticeWhy } from "../lib/notice-why"
import { qk } from "../state/keys"
import { mergeById } from "../state/merge"
import { useNow } from "../state/now"
import { sortMessages } from "../state/reduce"
import { useApprovals, useChannelPins, useChannelSummary, useChannels, useMe, useMembers, useMessages, useNotices, useOrg, usePending, useRuns, useThread, type PendingMessage } from "../state/queries"
import type { CompareGroup, Member, Message, NoticeAction, NoticeItem, Run, ThreadPage } from "../types"
import type { ChannelRef } from "../lib/channel-links"
import { AgentAvatar } from "./agent-avatar"
import { AnswerActions } from "./answer-actions"
import { AnswerBody } from "./answer-body"
import { AttachmentList } from "./attachments"
import { ChoiceCard } from "./choice-card"
import { buildCatchUp } from "./chat/catch-up"
import { CatchUpCard } from "./chat/catch-up-card"
import { filterContext, type ChatFilter } from "./chat/filters"
import { buildRows, unreadIds } from "./chat/rows"
import { CompareCard } from "./compare/compare-card"
import { Markdown } from "./markdown"
import { RunCard } from "./run-card"

export function MessageList({
  channelId,
  focusId,
  onRetry,
  onOpenThread,
  filter = "all",
  unread = 0,
  onMarkRead,
}: {
  channelId: string
  /** A message to scroll to and flash, from a search result. */
  focusId?: string
  onRetry: (item: PendingMessage) => void
  onOpenThread?: (message: Message) => void
  filter?: ChatFilter
  /** How many messages were unread when the channel was opened; 0 hides the markers. */
  unread?: number
  onMarkRead?: () => void
}) {
  const qc = useQueryClient()
  const messagesQuery = useMessages(channelId)
  const pins = useChannelPins(channelId)
  const pinnedIds = useMemo(() => new Set((pins.data ?? []).map((pin) => pin.message_id)), [pins.data])
  const [flash, setFlash] = useState<string | null>(null)
  const members = useMembers()
  const channelList = useChannels()
  const channelRefs = useMemo(() => channelList.data?.map(({ id, name }) => ({ id, name })), [channelList.data])
  const me = useMe()
  const runs = useRuns()
  const compares = useQuery({ queryKey: ["compares", channelId], queryFn: () => api.compares(channelId), refetchInterval: 5000 })
  const notices = useNotices()
  const pending = usePending(channelId)
  const now = useNow()
  // Replies live in the thread panel; the cache also holds streamed replies.
  const messages = (messagesQuery.data ?? []).filter((message) => !message.thread_id)
  const parentRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const stuckRef = useRef(true)
  const preserveRef = useRef<{ height: number; top: number } | null>(null)
  const anchorRef = useRef("")
  const [unstuck, setUnstuck] = useState(false)
  const [loadingEarlier, setLoadingEarlier] = useState(false)

  const visiblePending = (pending.data ?? []).filter((item) => {
    if (item.error) return true
    const mine = me.data?.id
    if (!mine) return true
    return !messages.some((message) => message.author_id === mine && message.body === item.body)
  })

  const approvals = useApprovals()
  const summary = useChannelSummary(channelId, unread > 0)
  const unreadSet = useMemo(() => unreadIds(messagesQuery.data ?? [], unread, me.data?.id), [messagesQuery.data, unread, me.data?.id])
  const showCatchUp = unread > 0 && filter === "all" && !!onMarkRead
  const rows = buildRows({
    messages,
    members: members.data ?? [],
    notices: (notices.data ?? []).filter((notice) => notice.channel_id === channelId),
    pending: visiblePending,
    filter,
    context: filterContext(me.data?.id, approvals.data ?? []),
    unread: unreadSet,
    catchUp: showCatchUp,
    now,
  })
  const newIndex = rows.findIndex((row) => row.kind === "new")

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

  // Jump to the message a search result named, then flash it for a moment.
  const focusIndex = focusId ? rows.findIndex((row) => row.key === focusId) : -1
  const flashTimer = useRef(0)
  function jumpTo(id: string) {
    const index = rows.findIndex((row) => row.key === id)
    if (index < 0) return
    stuckRef.current = false
    virtualizer.scrollToIndex(index, { align: "center" })
    setFlash(id)
    window.clearTimeout(flashTimer.current)
    flashTimer.current = window.setTimeout(() => setFlash(null), 2200)
  }
  useEffect(() => () => window.clearTimeout(flashTimer.current), [])
  useEffect(() => {
    if (!focusId || focusIndex < 0) return
    jumpTo(focusId)
    // The index moves while rows load; the target is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId, focusIndex >= 0])

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
    // Remember what is at the top, so a filter change can keep the reader there.
    const top = virtualizer.getVirtualItems().find((item) => item.end > el.scrollTop)
    const row = top ? rows[top.index] : undefined
    anchorRef.current = row ? row.at : ""
  }

  // After a filter change, scroll to the first row at or after the time the
  // reader was looking at. At the bottom, the stuck scroll already holds.
  useLayoutEffect(() => {
    if (stuckRef.current || !anchorRef.current) return
    const index = rows.findIndex((row) => row.at >= anchorRef.current)
    if (index >= 0) virtualizer.scrollToIndex(index, { align: "start" })
    // Only a filter change re-anchors.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter])

  function jumpFirstUnread() {
    if (newIndex < 0) return
    stuckRef.current = false
    virtualizer.scrollToIndex(newIndex, { align: "start" })
  }
  const range = virtualizer.range
  const newOffscreen = newIndex >= 0 && !!range && (newIndex < range.startIndex || newIndex > range.endIndex)

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
              const grouped = row.kind === "message" && row.grouped
              const lastInGroup = row.kind === "message" && row.lastInGroup
              const author = row.kind === "message" ? members.data?.find((member) => member.id === row.message.author_id) : undefined
              return (
                <div
                  key={row.key}
                  data-index={item.index}
                  ref={virtualizer.measureElement}
                  className={cx("absolute left-0 top-0 w-full px-3 md:px-4", grouped ? "py-0.5" : row.kind === "day" || row.kind === "new" ? "py-1" : "pb-0.5 pt-3")}
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  {row.kind === "message" && (
                    <MessageRow
                      message={row.message}
                      channelId={channelId}
                      author={author}
                      grouped={grouped}
                      lastInGroup={lastInGroup}
                      mine={row.message.author_id === me.data?.id}
                      mentionsMe={!!me.data && row.message.author_id !== me.data.id && row.message.mentions.includes(me.data.id)}
                      pinned={pinnedIds.has(row.message.id)}
                      flash={flash === row.message.id}
                      channels={channelRefs}
                      fresh={now - Date.parse(row.message.created_at) < 8000}
                      run={runs.data?.find((entry) => entry.id === row.message.run_id)}
                      compare={compares.data?.find((group) => group.message_id === row.message.id)}
                      onOpenThread={onOpenThread}
                    />
                  )}
                  {row.kind === "day" && <Divider label={row.label} />}
                  {row.kind === "new" && <Divider label="New" tone="accent" />}
                  {row.kind === "catchup" && onMarkRead && (
                    <CatchUpCard
                      data={buildCatchUp({
                        channelId,
                        unread: (messagesQuery.data ?? []).filter((message) => unreadSet.has(message.id)),
                        all: messagesQuery.data ?? [],
                        members: members.data ?? [],
                        runs: runs.data ?? [],
                        approvals: approvals.data ?? [],
                        ...(summary.data?.text ? { summary: summary.data.text } : {}),
                      })}
                      onJump={jumpTo}
                      onMarkRead={onMarkRead}
                    />
                  )}
                  {row.kind === "agents" && <AgentLine messages={row.messages} members={members.data ?? []} channels={channelRefs} />}
                  {row.kind === "notice" && <NoticeRow notice={row.notice} />}
                  {row.kind === "pending" && <PendingRow item={row.pending} onRetry={onRetry} />}
                </div>
              )
            })}
          </div>
        )}
      </div>
      {newOffscreen && (
        <button
          type="button"
          onClick={jumpFirstUnread}
          className="absolute left-1/2 top-3 z-10 min-h-8 -translate-x-1/2 rounded-full border border-accent bg-surface px-3 text-[12px] text-accent shadow"
        >
          Jump to first unread
        </button>
      )}
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

function Divider({ label, tone }: { label: string; tone?: "accent" }) {
  return (
    <div role="separator" aria-label={label} className={cx("flex items-center gap-3 text-[11px] font-medium", tone === "accent" ? "text-accent" : "text-faint")}>
      <span className={cx("h-px flex-1", tone === "accent" ? "bg-accent" : "bg-line")} />
      <span>{label}</span>
      <span className={cx("h-px flex-1", tone === "accent" ? "bg-accent" : "bg-line")} />
    </div>
  )
}

function MessageRow({
  message,
  channelId,
  author,
  grouped,
  lastInGroup,
  mine,
  mentionsMe,
  pinned,
  flash,
  channels,
  fresh,
  run,
  compare,
  onOpenThread,
}: {
  message: Message
  channelId: string
  author: Member | undefined
  grouped: boolean
  lastInGroup: boolean
  mine: boolean
  /** Someone else mentioned me, so the row gets an accent rail. */
  mentionsMe: boolean
  pinned: boolean
  flash: boolean
  channels: ChannelRef[] | undefined
  fresh: boolean
  run: Run | undefined
  compare: CompareGroup | undefined
  onOpenThread: ((message: Message) => void) | undefined
}) {
  const replies = message.reply_count ?? 0
  const authorName = author?.display_name ?? "Member"
  const time = formatClock(message.created_at)
  // Below 640px messages are bubbles: mine on the right, the others on the
  // left with the avatar at the bottom of the group and the name above it.
  return (
    <article
      id={`msg-${message.id}`}
      className={cx(
        "group/msg flex gap-2.5 rounded-md transition-colors duration-500 max-sm:items-end",
        mine && "max-sm:flex-row-reverse",
        fresh && "fz-rise",
        flash && "bg-accent-soft",
        mentionsMe && "border-l-2 border-accent pl-2",
      )}
    >
      <div className={cx("w-8 shrink-0", mine && "max-sm:hidden")}>
        {grouped ? (
          <time
            className="block pt-0.5 text-center font-mono text-[10px] leading-5 text-faint opacity-0 transition-opacity duration-150 group-hover/msg:opacity-100 max-sm:hidden"
            dateTime={message.created_at}
          >
            {time}
          </time>
        ) : (
          <AgentAvatar member={author} size={28} decorative className="mt-0.5 max-sm:hidden" />
        )}
        {lastInGroup && <AgentAvatar member={author} size={28} decorative className="sm:hidden" />}
      </div>
      <div className={cx("min-w-0 flex-1", mine && "max-sm:flex max-sm:flex-col max-sm:items-end")}>
        {!grouped && (
          <header className={cx("flex items-baseline gap-2", mine && "max-sm:hidden")}>
            <p className="text-[13px] font-semibold">{authorName}</p>
            <time className="font-mono text-[11px] text-faint" dateTime={message.created_at}>
              {time}
            </time>
            {message.edited_at && <span className="text-[11px] text-faint">edited</span>}
            {pinned && <span className="text-[11px] font-medium text-accent">Pinned</span>}
          </header>
        )}
        <div
          className={cx(
            "text-[15px]",
            !grouped && "mt-0.5",
            "max-sm:w-fit max-sm:max-w-[88%] max-sm:rounded-2xl max-sm:px-3 max-sm:py-1.5",
            mine ? "max-sm:rounded-br-md max-sm:bg-accent-soft" : "max-sm:rounded-bl-md max-sm:border max-sm:border-line max-sm:bg-surface",
          )}
        >
          <AnswerBody text={message.body} channels={channels} fold={author?.kind === "agent"} />
        </div>
        <AttachmentList attachments={message.attachments} />
        {message.options && message.options.length > 0 && <MessageChoices message={message} channelId={channelId} />}
        {run && <RunCard run={run} channelId={channelId} />}
        {compare && <CompareCard group={compare} />}
        {onOpenThread && (
          <p className="mt-0.5 flex items-center gap-3 text-[12px]">
            {replies > 0 && (
              <button
                type="button"
                onClick={() => onOpenThread(message)}
                className="min-h-8 rounded px-1 font-medium text-accent hover:underline md:min-h-6"
              >
                {replies} {replies === 1 ? "reply" : "replies"}
              </button>
            )}
            <button
              type="button"
              onClick={() => onOpenThread(message)}
              aria-label={`Reply in thread to ${authorName}`}
              className="min-h-8 rounded px-1 text-muted hover:text-ink hover:underline md:min-h-6 md:opacity-0 md:transition-opacity md:duration-150 md:group-hover/msg:opacity-100 md:focus-visible:opacity-100"
            >
              Reply in thread
            </button>
            <PinButton message={message} pinned={pinned} />
            {author?.kind === "agent" && <AnswerActions message={message} author={author} run={run} onOpenThread={onOpenThread} />}
          </p>
        )}
      </div>
    </article>
  )
}

// Pin or unpin from the message row. The pins list refetches when the
// message.pinned event arrives, and right away for the person who clicked.
function PinButton({ message, pinned }: { message: Message; pinned: boolean }) {
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  async function toggle() {
    setBusy(true)
    try {
      await (pinned ? api.unpinMessage(message.id) : api.pinMessage(message.id))
      await qc.invalidateQueries({ queryKey: qk.messagePins(message.channel_id) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => void toggle()}
      aria-pressed={pinned}
      className="min-h-8 rounded px-1 text-muted hover:text-ink hover:underline md:min-h-6 md:opacity-0 md:transition-opacity md:duration-150 md:group-hover/msg:opacity-100 md:focus-visible:opacity-100"
    >
      {pinned ? "Unpin" : "Pin"}
    </button>
  )
}

// The options of an ask_human message. The answer is a thread reply from the
// person, so it also shows for anyone else who opens the channel.
export function MessageChoices({ message, channelId }: { message: Message; channelId: string }) {
  const qc = useQueryClient()
  const members = useMembers()
  const thread = useThread(channelId, message.id)
  const [picked, setPicked] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const options = message.options ?? []
  const answered = answeredChoice(options, thread.replies, members.data ?? []) ?? picked

  function choose(index: number) {
    const option = options[index]
    if (option === undefined || answered !== null) return
    setPicked(index)
    setError(null)
    api.postMessage(channelId, { body: choiceBody(index, option), thread_id: message.id, idempotency_key: ulid() }).then(
      (reply) => {
        qc.setQueryData<ThreadPage | undefined>(qk.thread(message.id), (page) =>
          page ? { ...page, replies: mergeById([reply], page.replies) } : page,
        )
      },
      () => {
        setPicked(null)
        setError("Could not send the answer. Try again.")
      },
    )
  }

  return <ChoiceCard options={options} answered={answered} onChoose={choose} error={error} />
}

// "Coder", "Coder and Reviewer", "A, B and C", each with a small avatar.
function NameList({ people }: { people: Member[] }) {
  return people.map((person, index) => (
    <Fragment key={person.id}>
      {index === 0 ? "" : index === people.length - 1 ? " and " : ", "}
      <span className="inline-flex items-center gap-1 align-middle">
        <AgentAvatar member={person} size={16} decorative />
        <span className="font-medium text-ink">{person.display_name}</span>
      </span>
    </Fragment>
  ))
}

// Agents talking to each other collapse into one quiet line. Click to read.
function AgentLine({ messages, members, channels }: { messages: Message[]; members: Member[]; channels: ChannelRef[] | undefined }) {
  const [open, setOpen] = useState(false)
  const people = participants(messages, members)
  const [from, ...rest] = people
  return (
    <div className="ml-0 sm:ml-[42px]">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-10 w-full items-center gap-1 text-left text-[12px] text-muted hover:text-ink md:min-h-7"
      >
        {messages.length === 1 && from ? (
          <span>
            <NameList people={[from]} /> messaged <NameList people={rest} />
          </span>
        ) : (
          <span>
            {messages.length} messages between <NameList people={people} />
          </span>
        )}
        <span aria-hidden="true" className="ml-1 text-faint">
          {open ? "Hide" : "Show"}
        </span>
      </button>
      {open && (
        <ol className="fz-rise mb-1 flex flex-col gap-2 border-l-2 border-line pl-3">
          {messages.map((message) => {
            const writer = members.find((member) => member.id === message.author_id)
            return (
              <li key={message.id} className="text-[13px]">
                <p className="flex items-center gap-1.5 text-[12px] text-muted">
                  <AgentAvatar member={writer} size={16} decorative />
                  <span className="font-medium text-ink">{writer?.display_name ?? "Member"}</span>
                  <time className="font-mono text-faint" dateTime={message.created_at}>
                    {formatClock(message.created_at)}
                  </time>
                </p>
                <Markdown text={message.body} channels={channels} />
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}

function NoticeRow({ notice }: { notice: NoticeItem }) {
  const [explained, setExplained] = useState(false)
  const why = noticeWhy(notice)
  return (
    <div className="ml-[42px] text-[12px]">
      <div
        className={cx(
          "flex flex-wrap items-center gap-2",
          notice.level === "error" && "text-danger",
          notice.level === "warn" && "text-warn",
          notice.level === "info" && "text-muted",
        )}
      >
        <p>{notice.text}</p>
        {notice.action && <AssignButton action={notice.action} />}
        {why && (
          <button
            type="button"
            aria-expanded={explained}
            onClick={() => setExplained((value) => !value)}
            className="min-h-8 rounded px-1 text-muted underline-offset-2 hover:text-ink hover:underline md:min-h-6"
          >
            Why?
          </button>
        )}
      </div>
      {why && explained && <p className="fz-rise mt-0.5 max-w-prose text-muted">{why}</p>}
    </div>
  )
}

// The Director's button on a "not assigned to this project" notice.
function AssignButton({ action }: { action: NoticeAction }) {
  const qc = useQueryClient()
  const org = useOrg()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const project = org.data?.projects.find((item) => item.handle === action.project)
  if (project?.specialists.some((handle) => handle.toLowerCase() === action.agent.toLowerCase())) {
    return <span className="text-ok">Assigned</span>
  }
  async function assign() {
    setBusy(true)
    setFailed(false)
    try {
      await api.assign(action.project, { kind: "specialist", handle: action.agent })
      await qc.invalidateQueries({ queryKey: qk.org })
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <button
        type="button"
        disabled={busy}
        onClick={() => void assign()}
        className="min-h-10 rounded border border-line bg-surface px-2 text-[12px] text-ink hover:bg-canvas disabled:opacity-60 md:min-h-7"
      >
        {action.label}
      </button>
      {failed && <span role="alert">Could not assign. Try again.</span>}
    </>
  )
}

function PendingRow({ item, onRetry }: { item: PendingMessage; onRetry: (item: PendingMessage) => void }) {
  return (
    <article className="ml-[42px] text-[13px] text-muted">
      <Markdown text={item.body} />
      {item.attachments && item.attachments.length > 0 && (
        <p className="mt-0.5 text-[12px] text-faint">{item.attachments.map((file) => file.name).join(", ")}</p>
      )}
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

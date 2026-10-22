import { useVirtualizer } from "@tanstack/react-virtual"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { api } from "../api/client"
import { participants } from "../lib/agent-chat"
import { answeredChoice, choiceBody } from "../lib/choices"
import { delegationLines } from "../lib/delegation"
import { ulid } from "../lib/id"
import { formatClock } from "../lib/time"
import { cx } from "../lib/cx"
import { noticeWhy } from "../lib/notice-why"
import { qk } from "../state/keys"
import { mergeById } from "../state/merge"
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
import { HumanAvatar } from "./chat/human-avatar"
import { filterContext, type ChatFilter } from "./chat/filters"
import { buildRows, unreadIds } from "./chat/rows"
import { CompareCard } from "./compare/compare-card"
import { Markdown } from "./markdown"
import { RunCard } from "./run-card"
import { useProfileNavigation } from "./profile/navigation"

const EMPTY_MESSAGES: Message[] = []
const EMPTY_MEMBERS: Member[] = []
const EMPTY_RUNS: Run[] = []
const EMPTY_NOTICES: NoticeItem[] = []
const EMPTY_PENDING: PendingMessage[] = []

export function comparePollInterval(groups: CompareGroup[] | undefined): number | false {
  return groups?.some((group) =>
    !group.decision && group.candidates.some((candidate) =>
      !candidate.run || candidate.run.state === "queued" || candidate.run.state === "running" || candidate.run.state === "verifying"),
  ) ? 5000 : false
}

export function MessageList({
  channelId,
  focusId,
  onRetry,
  onOpenThread,
  filter = "all",
  unread = 0,
  onMarkRead,
  onSuggestion,
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
  onSuggestion?: (text: string) => void
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
  const compares = useQuery({
    queryKey: ["compares", channelId], queryFn: () => api.compares(channelId),
    refetchInterval: (query) => comparePollInterval(query.state.data),
  })
  const notices = useNotices()
  const pending = usePending(channelId)
  // Replies live in the thread panel; the cache also holds streamed replies.
  const allMessages = messagesQuery.data ?? EMPTY_MESSAGES
  const messages = useMemo(() => allMessages.filter((message) => !message.thread_id), [allMessages])
  const messageCount = messages.length
  const lastMessageId = messages.at(-1)?.id
  const memberList = members.data ?? EMPTY_MEMBERS
  const channelMemberIds = channelList.data?.find((channel) => channel.id === channelId)?.member_ids ?? []
  const runList = runs.data ?? EMPTY_RUNS
  const noticeList = notices.data ?? EMPTY_NOTICES
  const pendingList = pending.data ?? EMPTY_PENDING
  const memberById = useMemo(() => new Map(memberList.map((member) => [member.id, member])), [memberList])
  const runById = useMemo(() => new Map(runList.map((run) => [run.id, run])), [runList])
  const compareByMessage = useMemo(() => new Map(compares.data?.map((group) => [group.message_id, group]) ?? []), [compares.data])
  // Root id to "3 pieces: 1 running, 1 done, 1 failed", from the handoff
  // replies in the cache and the runs they started. A string, so the memoized
  // row only re-renders when its own line changes.
  const delegation = useMemo(() => delegationLines(allMessages, runList, memberList), [allMessages, runList, memberList])
  const parentRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const stuckRef = useRef(true)
  const userScrollAtRef = useRef(0)
  const preserveRef = useRef<{ height: number; top: number } | null>(null)
  const anchorRef = useRef("")
  const [unstuck, setUnstuck] = useState(false)
  const [newWhileAway, setNewWhileAway] = useState(0)
  const seenMessages = useRef({ channelId, count: messageCount, lastId: lastMessageId })
  const [loadingEarlier, setLoadingEarlier] = useState(false)

  useEffect(() => {
    const previous = seenMessages.current
    if (previous.channelId === channelId && unstuck && messageCount > previous.count && lastMessageId !== previous.lastId) {
      setNewWhileAway((count) => count + messageCount - previous.count)
    }
    seenMessages.current = { channelId, count: messageCount, lastId: lastMessageId }
  }, [channelId, messageCount, lastMessageId, unstuck])

  const visiblePending = useMemo(() => pendingList.filter((item) => {
    if (item.error) return true
    const mine = me.data?.id
    if (!mine) return true
    return !messages.some((message) => message.author_id === mine && message.body === item.body)
  }), [pendingList, me.data?.id, messages])
  const channelNotices = useMemo(() => noticeList.filter((notice) => notice.channel_id === channelId), [noticeList, channelId])

  const approvals = useApprovals()
  const summary = useChannelSummary(channelId, unread > 0)
  const unreadSet = useMemo(() => unreadIds(allMessages, unread, me.data?.id), [allMessages, unread, me.data?.id])
  const showCatchUp = unread > 0 && filter === "all" && !!onMarkRead
  const context = useMemo(() => filterContext(me.data?.id, approvals.data ?? []), [me.data?.id, approvals.data])
  const rows = useMemo(() => buildRows({
    messages,
    members: memberList,
    notices: channelNotices,
    pending: visiblePending,
    filter,
    context,
    unread: unreadSet,
    catchUp: showCatchUp,
    now: Date.now(),
  }), [messages, memberList, channelNotices, visiblePending, filter, context, unreadSet, showCatchUp])
  const catchUp = useMemo(() => showCatchUp ? buildCatchUp({
    channelId, unread: allMessages.filter((message) => unreadSet.has(message.id)), all: allMessages,
    members: memberList, runs: runList, approvals: approvals.data ?? [],
    ...(summary.data?.text ? { summary: summary.data.text } : {}),
  }) : null, [showCatchUp, channelId, allMessages, unreadSet, memberList, runList, approvals.data, summary.data?.text])
  const newIndex = rows.findIndex((row) => row.kind === "new")

  // TanStack Virtual returns functions the React compiler cannot memoize.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 88,
    overscan: 8,
    getItemKey: (index) => rows[index]?.key ?? index,
  })
  useLayoutEffect(() => {
    // The virtualizer owns size changes above a scrolled-up reader. At the
    // bottom, the inner observer owns pinning, so the two do not both scroll.
    virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) =>
      !stuckRef.current && !preserveRef.current && item.start < (instance.scrollOffset ?? 0)
    return () => { virtualizer.shouldAdjustScrollPositionOnItemSizeChange = undefined }
  }, [virtualizer])

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

  const lastPendingKey = pendingList.at(-1)?.key
  const seenPendingKey = useRef(lastPendingKey)
  useLayoutEffect(() => {
    if (lastPendingKey && lastPendingKey !== seenPendingKey.current) {
      jumpLatest()
    }
    seenPendingKey.current = lastPendingKey
  }, [lastPendingKey, rows.length])

  const latestMineId = useMemo(() => {
    if (!me.data?.id) return undefined
    for (let index = messages.length - 1; index >= 0; index--) {
      if (messages[index]?.author_id === me.data.id) return messages[index]?.id
    }
    return undefined
  }, [messages, me.data?.id])
  const seenMine = useRef({ channelId, id: latestMineId })
  useLayoutEffect(() => {
    if (seenMine.current.channelId === channelId && latestMineId && latestMineId !== seenMine.current.id) {
      jumpLatest()
    }
    seenMine.current = { channelId, id: latestMineId }
  }, [channelId, latestMineId])

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
    // A growing row can fire scroll before the inner ResizeObserver pins the
    // bottom. Only input from the reader may release a pinned transcript.
    if (stuckRef.current && distance >= 48 && Date.now() - userScrollAtRef.current > 250) {
      el.scrollTop = el.scrollHeight
      return
    }
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
    setNewWhileAway(0)
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
        onWheel={() => { userScrollAtRef.current = Date.now() }}
        onTouchMove={() => { userScrollAtRef.current = Date.now() }}
        onPointerDown={() => { userScrollAtRef.current = Date.now() }}
        onKeyDown={() => { userScrollAtRef.current = Date.now() }}
      >
        {messagesQuery.isPending ? (
          <p className="px-4 py-6 text-[13px] text-muted">Loading messages</p>
        ) : rows.length === 0 ? (
          filter === "all" && messages.length === 0 ?
            <EmptyChannel agents={memberList.filter((member) => member.kind === "agent" && channelMemberIds.includes(member.id))} onSuggestion={onSuggestion} /> :
            <p className="px-4 py-8 text-center text-[13px] text-muted">No messages match this filter.</p>
        ) : (
          <div ref={innerRef} className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index]
              if (!row) return null
              const grouped = row.kind === "message" && row.grouped
              const lastInGroup = row.kind === "message" && row.lastInGroup
              const author = row.kind === "message" ? memberById.get(row.message.author_id) : undefined
              return (
                <div
                  key={row.key}
                  data-index={item.index}
                  ref={virtualizer.measureElement}
                  className={cx("absolute left-0 top-0 w-full px-3 md:px-4", grouped ? "py-0.5" : row.kind === "day" || row.kind === "new" ? "py-1" : "pb-0.5 pt-1.5")}
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
                      run={runById.get(row.message.run_id ?? "")}
                      compare={compareByMessage.get(row.message.id)}
                      delegation={delegation.get(row.message.id)}
                      onOpenThread={onOpenThread}
                    />
                  )}
                  {row.kind === "day" && <Divider label={row.label} />}
                  {row.kind === "new" && <Divider label="New" tone="accent" />}
                  {row.kind === "catchup" && onMarkRead && catchUp && (
                    <CatchUpCard
                      data={catchUp}
                      onJump={jumpTo}
                      onMarkRead={onMarkRead}
                    />
                  )}
                  {row.kind === "agents" && <AgentLine messages={row.messages} members={memberList} channels={channelRefs} />}
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
          {newWhileAway > 0 ? `Jump to latest (${newWhileAway} new)` : "Jump to latest"}
        </button>
      )}
    </div>
  )
}

function EmptyChannel({ agents, onSuggestion }: { agents: Member[]; onSuggestion?: (text: string) => void }) {
  const suggestions = Array.from({ length: agents.length ? Math.min(3, Math.max(2, agents.length)) : 0 }, (_, index) => {
    const handle = agents[index % agents.length]!.handle
    if (index === 0) return `@${handle} What should we work on first?`
    if (index === 1) return `@${handle} Review the current plan.`
    return `@${handle} What needs attention today?`
  })
  return <div className="mx-auto flex max-w-md flex-col items-center px-5 py-12 text-center">
    <div className="mb-3 flex -space-x-1.5">{agents.slice(0, 3).map((agent) => <AgentAvatar key={agent.id} member={agent} size={28} decorative className="rounded-full ring-2 ring-canvas" />)}</div>
    <h2 className="text-[15px] font-semibold">No messages yet.</h2>
    <p className="mt-1 text-[13px] text-muted">Start the conversation here.</p>
    {suggestions.length > 0 && <div className="mt-4 flex w-full flex-col gap-2">{suggestions.map((suggestion) =>
      <button key={suggestion} type="button" disabled={!onSuggestion} onClick={() => onSuggestion?.(suggestion)} className="min-h-10 rounded-lg border border-line bg-surface px-3 py-2 text-left text-[13px] text-ink hover:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-default">{suggestion}</button>,
    )}</div>}
  </div>
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

const MessageRow = memo(function MessageRow({
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
  run,
  compare,
  delegation,
  onOpenThread,
}: {
  message: Message
  channelId: string
  author: Member | undefined
  grouped: boolean
  lastInGroup: boolean
  mine: boolean
  /** Someone else mentioned me, so the row gets an accent tint. */
  mentionsMe: boolean
  pinned: boolean
  flash: boolean
  channels: ChannelRef[] | undefined
  run: Run | undefined
  compare: CompareGroup | undefined
  /** The pieces handed out under this message, in one line. */
  delegation: string | undefined
  onOpenThread: ((message: Message) => void) | undefined
}) {
  const { openProfile } = useProfileNavigation()
  const [fresh] = useState(() => Date.now() - Date.parse(message.created_at) < 8000)
  const replies = message.reply_count ?? 0
  const authorName = author?.display_name ?? "Member"
  const time = formatClock(message.created_at)
  // Below 640px messages are bubbles: mine on the right, the others on the
  // left with the avatar at the bottom of the group and the name above it.
  return (
    <article
      id={`msg-${message.id}`}
      className={cx(
        "group/msg relative flex gap-2.5 rounded-lg px-1.5 py-1 transition-colors duration-200 max-sm:items-end",
        mine && "max-sm:flex-row-reverse",
        fresh && "fz-rise",
        flash && "bg-accent-soft",
        mentionsMe && !flash && "bg-accent-soft",
        author?.kind === "agent" && !mentionsMe && !flash && "bg-sidebar/40",
      )}
    >
      <div className={cx("w-8 shrink-0", mine && "max-sm:hidden")}>
        {grouped ? (
          <time
            className="block pt-0.5 text-center font-mono text-[10px] leading-5 text-faint opacity-0 transition-opacity duration-150 group-hover/msg:opacity-100 max-sm:hidden"
            dateTime={message.created_at}
            title={new Date(message.created_at).toLocaleString()}
          >
            {time}
          </time>
        ) : (
          <button type="button" tabIndex={-1} onClick={() => author && openProfile(author.handle)} disabled={!author} aria-label={author ? `Profile: @${author.handle}` : undefined} className="mt-0.5 flex shrink-0 rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent max-sm:hidden">{author?.kind === "human" ? <HumanAvatar member={author} className="max-sm:hidden" /> : <AgentAvatar member={author} size={28} decorative className="max-sm:hidden" />}</button>
        )}
        {lastInGroup && <button type="button" onClick={() => author && openProfile(author.handle)} disabled={!author} aria-label={author ? `Profile: @${author.handle}` : undefined} className="flex shrink-0 rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent sm:hidden">{author?.kind === "human" ? <HumanAvatar member={author} /> : <AgentAvatar member={author} size={28} decorative />}</button>}
      </div>
      <div className={cx("min-w-0 flex-1", mine && "max-sm:flex max-sm:flex-col max-sm:items-end")}>
        {!grouped && (
          <header className={cx("flex items-baseline gap-2 md:pr-40", mine && "max-sm:hidden")}>
            {author ? <button type="button" onClick={() => openProfile(author.handle)} className="rounded text-[13px] font-semibold hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">{authorName}</button> : <p className="text-[13px] font-semibold">{authorName}</p>}
            <time className="font-mono text-[11px] text-faint" dateTime={message.created_at} title={new Date(message.created_at).toLocaleString()}>
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
        {delegation && (
          <p className="mt-1 text-[12px]">
            {onOpenThread ? (
              <button
                type="button"
                onClick={() => onOpenThread(message)}
                aria-label={`Delegation: ${delegation}. Open the thread`}
                className="inline-flex min-h-8 flex-wrap items-center gap-x-1.5 rounded px-1 text-left text-muted hover:text-ink hover:underline md:min-h-6"
              >
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-hidden="true" />
                <span className="font-medium text-ink">Delegated</span>
                <span>{delegation}</span>
              </button>
            ) : (
              <span className="text-muted">
                <span className="font-medium text-ink">Delegated</span> {delegation}
              </span>
            )}
          </p>
        )}
        {onOpenThread && (
          <div className="mt-0.5 flex items-center gap-1 text-[12px]">
            {replies > 0 && (
              <button
                type="button"
                onClick={() => onOpenThread(message)}
                className="min-h-8 rounded px-1 font-medium text-accent hover:underline md:min-h-6"
              >
                {replies} {replies === 1 ? "reply" : "replies"}
              </button>
            )}
            <div role="group" aria-label={`Actions for ${authorName}'s message`} className="ml-auto flex items-center gap-0.5 rounded-lg border border-line bg-surface p-0.5 opacity-100 shadow-sm transition-opacity duration-150 md:absolute md:right-1.5 md:top-1 md:opacity-0 md:group-hover/msg:opacity-100 md:group-focus-within/msg:opacity-100">
              <button type="button" onClick={() => onOpenThread(message)} aria-label={`Reply in thread to ${authorName}`} title="Reply in thread" className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-sidebar hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
                <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 4h12v9H9l-4 3v-3H4z" /></svg>
              </button>
              <PinButton message={message} pinned={pinned} />
              <CopyButton text={message.body} />
              {author?.kind === "agent" && <AnswerActions message={message} author={author} run={run} onOpenThread={onOpenThread} />}
            </div>
          </div>
        )}
      </div>
    </article>
  )
})

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
      aria-label={pinned ? "Unpin" : "Pin"}
      title={pinned ? "Unpin" : "Pin"}
      className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-sidebar hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
    >
      <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m12 3 5 5-2 1-2.5 3.5.5 2.5-1 1-3-3-4.5 4.5M7 8l-1-1 1-1 1.5 1.5" /></svg>
    </button>
  )
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      setCopied(false)
    }
  }
  return <button type="button" onClick={() => void copy()} aria-label={copied ? "Copied" : "Copy message"} title={copied ? "Copied" : "Copy message"} className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-sidebar hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
    <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="7" y="6" width="9" height="11" rx="1.5" /><path d="M13 6V4.5A1.5 1.5 0 0 0 11.5 3h-6A1.5 1.5 0 0 0 4 4.5v8A1.5 1.5 0 0 0 5.5 14H7" /></svg>
  </button>
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
        {notice.action?.kind === "assign" && <AssignButton action={notice.action} />}
        {notice.action?.kind === "approval_rule_remove" && <RemoveRuleButton action={notice.action} />}
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
function AssignButton({ action }: { action: Extract<NoticeAction, { kind: "assign" }> }) {
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

function RemoveRuleButton({ action }: { action: Extract<NoticeAction, { kind: "approval_rule_remove" }> }) {
  const [removed, setRemoved] = useState(false)
  const [error, setError] = useState(false)
  if (removed) return <span>Rule removed</span>
  return <><button type="button" className="min-h-8 rounded border border-line bg-surface px-2 text-[12px]" onClick={() => void api.deleteApprovalRule(action.rule_id).then(() => setRemoved(true)).catch(() => setError(true))}>{action.label}</button>{error && <span role="alert">Could not remove rule</span>}</>
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

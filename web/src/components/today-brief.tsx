import { useQueries } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { api } from "../api/client"
import { questionsWaiting } from "../lib/approval-inbox"
import { cx } from "../lib/cx"
import { plainPreview } from "../lib/inbox"
import { buildToday, readOpen, readSeen, resetLabel, writeOpen, writeSeen, type FinishedGroup, type Outcome } from "../lib/today"
import { formatAge, formatElapsed } from "../lib/time"
import { qk } from "../state/keys"
import { useNow } from "../state/now"
import { useAllMessages, useApprovals, useChannels, useLanes, useMembers, useOrg, useRuns } from "../state/queries"
import type { Message } from "../types"

const OUTCOME: Record<Outcome, { label: string; className: string }> = {
  failed: { label: "failed", className: "bg-danger-soft text-danger" },
  waiting: { label: "waiting", className: "bg-warn-soft text-warn" },
  merged: { label: "merged", className: "bg-ok-soft text-ok" },
  kept: { label: "kept", className: "bg-sidebar text-muted" },
  discarded: { label: "discarded", className: "bg-sidebar text-muted" },
  no_changes: { label: "no changes", className: "bg-sidebar text-muted" },
  answer: { label: "read answer", className: "bg-sidebar text-muted" },
  cancelled: { label: "cancelled", className: "bg-sidebar text-muted" },
}

const ROW = "flex min-h-10 min-w-0 items-center gap-2 rounded-md border border-line bg-surface px-2 py-1.5 text-left hover:bg-canvas"

// The morning brief at the top of the inbox: what waits for the Director, what
// finished since the last visit, what runs now and which lanes are short. It
// reads the queries the rest of the app already loads.
export function TodayBrief() {
  const now = useNow()
  const approvals = useApprovals()
  const channels = useChannels()
  const members = useMembers()
  const org = useOrg()
  const runs = useRuns()
  const lanes = useLanes()
  const [open, setOpen] = useState(readOpen)
  const [seen, setSeen] = useState(() => readSeen(Date.now()))
  const [allFinished, setAllFinished] = useState(false)

  // A question is a message with options and no human answer in its thread.
  const channelList = channels.data ?? []
  const people = members.data ?? []
  const messages = useAllMessages(channelList.map((channel) => channel.id))
  const withOptions = messages.filter((message) => message.options && message.options.length > 0 && !message.thread_id)
  const threads = useQueries({
    queries: withOptions
      .filter((message) => (message.reply_count ?? 0) > 0)
      .map((message) => ({ queryKey: qk.thread(message.id), queryFn: () => api.thread(message.id) })),
  })
  const replies = new Map<string, Message[]>()
  for (const thread of threads) if (thread.data) replies.set(thread.data.root.id, thread.data.replies)
  const questions = questionsWaiting(withOptions, replies, channelList, org.data?.projects ?? [], people).map((item) => item.message)

  const today = buildToday({
    runs: runs.data ?? [],
    approvals: approvals.data ?? [],
    questions,
    channels: channelList,
    members: people,
    lanes: lanes.data ?? [],
    seen,
    now,
  })

  function toggle() {
    writeOpen(!open)
    setOpen(!open)
  }

  function markSeen() {
    const stamp = Date.now()
    writeSeen(stamp)
    setSeen(stamp)
  }

  const waiting = today.needs.length
  return (
    <section aria-label="Today" className="border-b border-line px-3 pb-3" data-testid="today">
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-expanded={open}
          onClick={toggle}
          className="flex min-h-10 min-w-0 flex-1 items-center gap-2 text-left text-[13px] font-semibold"
        >
          <span aria-hidden="true" className={cx("text-[11px] text-muted transition-transform", open && "rotate-90")}>
            &gt;
          </span>
          Today
          {waiting > 0 && <span className="rounded-full bg-accent px-1.5 text-[11px] font-medium text-canvas">{waiting}</span>}
        </button>
        {open && (
          <button type="button" onClick={markSeen} className="min-h-10 shrink-0 rounded-md px-2 text-[12px] text-muted hover:bg-sidebar hover:text-ink">
            Mark as seen
          </button>
        )}
      </div>
      {open && (
        <div className="flex flex-col gap-3">
          <Group title="Needs you">
            {today.needs.length === 0 ? (
              <p className="text-[12px] text-muted">Nothing waits for you.</p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {today.needs.map((item) => (
                  <li key={item.id}>
                    {item.kind === "approval" ? (
                      <Link to="/approvals" search={{ a: item.id }} className={ROW}>
                        <NeedRow label="approval" item={item} now={now} />
                      </Link>
                    ) : (
                      <Link to="/c/$channelId" params={{ channelId: item.channelId }} className={ROW}>
                        <NeedRow label="question" item={item} now={now} />
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Group>
          <Group title="Finished since you were last here">
            {today.finished.length === 0 ? (
              <p className="text-[12px] text-muted">Nothing new.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {shownFinished(today.finished, allFinished).map((group) => (
                  <div key={group.channelId} className="flex flex-col gap-1.5">
                    <h3 className="truncate text-[12px] text-muted"># {group.channel}</h3>
                    <ul className="flex flex-col gap-1.5">
                      {group.items.map((item) => (
                        <li key={item.run.id}>
                          <Link
                            to="/c/$channelId"
                            params={{ channelId: item.run.channel_id }}
                            search={{ run: item.run.id }}
                            className={cx(ROW, "flex-wrap")}
                          >
                            <span className="min-w-0 truncate text-[13px] font-medium">@{item.agent}</span>
                            <span className="shrink-0 text-[12px] text-muted">{item.run.lane_id}</span>
                            <span className={cx("shrink-0 rounded-full px-2 text-[11px]", OUTCOME[item.outcome].className)}>{OUTCOME[item.outcome].label}</span>
                            <span className="ml-auto shrink-0 text-[12px] text-muted">{formatElapsed(item.run.started_at, item.run.ended_at, now)}</span>
                            {item.reason && <span className="basis-full break-words text-[12px] text-danger">{item.reason}</span>}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
                {hiddenFinished(today.finished, allFinished) > 0 && (
                  <button
                    type="button"
                    onClick={() => setAllFinished(true)}
                    className="min-h-10 self-start rounded-md px-2 text-[12px] text-muted hover:bg-sidebar hover:text-ink"
                  >
                    Show {hiddenFinished(today.finished, allFinished)} more
                  </button>
                )}
              </div>
            )}
          </Group>
          <Group title="Running now">
            {today.running.length === 0 ? (
              <p className="text-[12px] text-muted">No runs are active.</p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {today.running.map((item) => (
                  <li key={item.run.id}>
                    <Link to="/c/$channelId" params={{ channelId: item.run.channel_id }} search={{ run: item.run.id }} className={ROW}>
                      <span className="min-w-0 flex-1 truncate text-[13px]">
                        <span className="font-medium">@{item.agent}</span> <span className="text-muted">in #{item.channel}</span>
                      </span>
                      <span className="shrink-0 text-[12px] text-muted">{item.run.lane_id}</span>
                      <span className="shrink-0 text-[12px] text-muted">
                        {item.run.started_at ? formatElapsed(item.run.started_at, undefined, now) : "queued"}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Group>
          {today.lanes.length > 0 && (
            <Group title="Lanes">
              <ul className="flex flex-col gap-1.5">
                {today.lanes.map((item) => (
                  <li key={item.id}>
                    <Link to="/lanes" className={ROW}>
                      <span className="min-w-0 flex-1 truncate text-[13px]">{item.id}</span>
                      <span className={cx("shrink-0 rounded-full px-2 text-[11px]", item.health === "conserve" ? "bg-warn-soft text-warn" : "bg-danger-soft text-danger")}>
                        {item.health}
                      </span>
                      <span className="shrink-0 text-[12px] text-muted">{resetLabel(item, now)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Group>
          )}
        </div>
      )}
    </section>
  )
}

// FINISHED_SHOWN keeps a busy day from pushing the chats off the page; the
// failures come first, so they stay in view.
const FINISHED_SHOWN = 6

function shownFinished(groups: FinishedGroup[], all: boolean): FinishedGroup[] {
  if (all) return groups
  let left = FINISHED_SHOWN
  const out: FinishedGroup[] = []
  for (const group of groups) {
    if (left <= 0) break
    out.push({ ...group, items: group.items.slice(0, left) })
    left -= group.items.length
  }
  return out
}

function hiddenFinished(groups: FinishedGroup[], all: boolean): number {
  if (all) return 0
  const total = groups.reduce((sum, group) => sum + group.items.length, 0)
  return Math.max(0, total - FINISHED_SHOWN)
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <h2 className="text-[13px] font-semibold">{title}</h2>
      {children}
    </div>
  )
}

function NeedRow({ label, item, now }: { label: string; item: { agent: string; channel: string; title: string; at: number | undefined }; now: number }) {
  return (
    <>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px]">{plainPreview(item.title)}</span>
        <span className="block truncate text-[12px] text-muted">
          {label} - @{item.agent} in #{item.channel}
        </span>
      </span>
      <span className="shrink-0 text-[12px] text-muted">{item.at === undefined ? "" : formatAge(new Date(item.at).toISOString(), now)}</span>
    </>
  )
}

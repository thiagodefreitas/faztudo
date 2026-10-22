import { useQueries } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useEffect, useRef, useState, type ReactNode } from "react"
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
import { AgentAvatar } from "./agent-avatar"
import { HealthIcon } from "./lanes"

// The command palette sends this to open the brief and bring it into view.
export const OPEN_TODAY_EVENT = "faztudo:open-today"

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

const ROW =
  "group flex min-h-14 min-w-0 items-center gap-3 rounded-xl border border-line bg-surface px-3 py-2 text-left shadow-[0_1px_2px_rgb(16_24_40/0.04)] transition-colors duration-150 hover:bg-canvas"

// The morning brief at the top of the inbox: what waits for the Director, what
// finished since the last visit, what runs now and which lanes are short. It
// reads the queries the rest of the app already loads. Empty sections fold
// away; only "Needs you" always answers, so a quiet day reads as quiet.
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
  const root = useRef<HTMLElement>(null)

  useEffect(() => {
    function onOpen() {
      writeOpen(true)
      setOpen(true)
      root.current?.scrollIntoView?.({ block: "start" })
    }
    window.addEventListener(OPEN_TODAY_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_TODAY_EVENT, onOpen)
  }, [])

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
  const memberOf = (handle: string) => people.find((member) => member.handle === handle)
  const laneList = lanes.data ?? []
  const finishedShown = shownFinished(today.finished, allFinished)
  const more = hiddenFinished(today.finished, allFinished)
  return (
    <section ref={root} aria-label="Today" className="scroll-mt-2 px-4 pb-2 pt-1" data-testid="today">
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-expanded={open}
          onClick={toggle}
          className="-ml-1 flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-md px-1 text-left text-[13px] font-semibold"
        >
          <svg
            viewBox="0 0 16 16"
            aria-hidden="true"
            className={cx("h-3.5 w-3.5 shrink-0 text-muted transition-transform duration-150 motion-reduce:transition-none", open && "rotate-90")}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m6 3.5 4.5 4.5L6 12.5" />
          </svg>
          Today
          {waiting > 0 && <span className="rounded-full bg-accent px-1.5 text-[11px] font-medium tabular-nums text-canvas">{waiting}</span>}
        </button>
        {open && (
          <button
            type="button"
            onClick={markSeen}
            className="min-h-10 shrink-0 rounded-md px-2 text-[12px] text-muted transition-colors duration-150 hover:bg-sidebar hover:text-ink md:min-h-8"
          >
            Mark as seen
          </button>
        )}
      </div>
      {open && (
        <div className="flex flex-col gap-4 pb-1 pt-1">
          <Group title="Needs you">
            {today.needs.length === 0 ? (
              <p className="flex min-h-8 items-center gap-2 text-[13px] text-muted">
                <svg
                  viewBox="0 0 16 16"
                  aria-hidden="true"
                  className="h-4 w-4 shrink-0 text-ok"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="8" cy="8" r="6.25" />
                  <path d="m5.5 8.2 1.8 1.8 3.3-3.6" />
                </svg>
                Nothing waits for you.
              </p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {today.needs.map((item) => {
                  const body = (
                    <ItemRow
                      lead={<AgentAvatar member={memberOf(item.agent)} size={28} state="waiting" decorative />}
                      title={plainPreview(item.title)}
                      pill={<Pill className={item.kind === "approval" ? "bg-warn-soft text-warn" : "bg-accent-soft text-accent"}>{item.kind}</Pill>}
                      meta={`@${item.agent} in #${item.channel}`}
                      time={item.at === undefined ? "" : formatAge(new Date(item.at).toISOString(), now)}
                      action={item.kind === "approval" ? "Review" : "Answer"}
                      primary
                    />
                  )
                  return (
                    <li key={item.id}>
                      {item.kind === "approval" ? (
                        <Link to="/approvals" search={{ a: item.id }} className={ROW}>
                          {body}
                        </Link>
                      ) : (
                        <Link to="/c/$channelId" params={{ channelId: item.channelId }} className={ROW}>
                          {body}
                        </Link>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </Group>
          {today.finished.length > 0 && (
            <Group title="Finished since you were last here">
              <ul className="flex flex-col gap-1.5">
                {finishedShown.flatMap((group) =>
                  group.items.map((item) => (
                    <li key={item.run.id}>
                      <Link to="/c/$channelId" params={{ channelId: item.run.channel_id }} search={{ run: item.run.id }} className={ROW}>
                        <ItemRow
                          lead={
                            <AgentAvatar
                              member={memberOf(item.agent)}
                              size={28}
                              state={item.outcome === "failed" ? "failed" : item.outcome === "waiting" ? "waiting" : undefined}
                              decorative
                            />
                          }
                          title={
                            <>
                              <span>@{item.agent}</span> <span className="font-normal text-muted">in #{group.channel}</span>
                            </>
                          }
                          pill={<Pill className={OUTCOME[item.outcome].className}>{OUTCOME[item.outcome].label}</Pill>}
                          meta={item.reason ? <span className="text-danger">{item.reason}</span> : <span className="font-mono text-[11px]">{item.run.lane_id}</span>}
                          time={formatElapsed(item.run.started_at, item.run.ended_at, now)}
                          action={item.outcome === "waiting" ? "Review" : "Open"}
                          primary={item.outcome === "waiting"}
                        />
                      </Link>
                    </li>
                  )),
                )}
              </ul>
              {more > 0 && (
                <button
                  type="button"
                  onClick={() => setAllFinished(true)}
                  className="min-h-10 self-start rounded-md px-2 text-[12px] text-muted transition-colors duration-150 hover:bg-sidebar hover:text-ink md:min-h-8"
                >
                  Show {more} more
                </button>
              )}
            </Group>
          )}
          {today.running.length > 0 && (
            <Group title="Running now">
              <ul className="flex flex-col gap-1.5">
                {today.running.map((item) => (
                  <li key={item.run.id}>
                    <Link to="/c/$channelId" params={{ channelId: item.run.channel_id }} search={{ run: item.run.id }} className={ROW}>
                      <ItemRow
                        lead={<AgentAvatar member={memberOf(item.agent)} size={28} state="working" decorative />}
                        title={
                          <>
                            <span>@{item.agent}</span> <span className="font-normal text-muted">in #{item.channel}</span>
                          </>
                        }
                        pill={<Pill className="bg-accent-soft text-accent">{item.run.started_at ? "running" : "queued"}</Pill>}
                        meta={<span className="font-mono text-[11px]">{item.run.lane_id}</span>}
                        time={item.run.started_at ? formatElapsed(item.run.started_at, undefined, now) : ""}
                        action="Open"
                      />
                    </Link>
                  </li>
                ))}
              </ul>
            </Group>
          )}
          {today.lanes.length > 0 ? (
            <Group title="Lanes">
              <ul className="flex flex-col gap-1.5">
                {today.lanes.map((item) => {
                  const tone = item.health === "conserve" ? "bg-warn-soft text-warn" : "bg-danger-soft text-danger"
                  return (
                    <li key={item.id}>
                      <Link to="/lanes" search={{ lane: item.id }} className={ROW}>
                        <ItemRow
                          lead={
                            <span className={cx("inline-flex h-7 w-7 items-center justify-center rounded-lg", tone)}>
                              <HealthIcon health={item.health} className="h-2.5 w-2.5" />
                            </span>
                          }
                          title={<span className="font-mono text-[12px]">{item.id}</span>}
                          pill={<Pill className={tone}>{item.health}</Pill>}
                          meta={<span className="tabular-nums">{resetLabel(item, now)}</span>}
                          time=""
                          action="Open"
                        />
                      </Link>
                    </li>
                  )
                })}
              </ul>
            </Group>
          ) : (
            laneList.length > 0 && (
              <Link
                to="/lanes"
                className="-ml-1 flex min-h-10 items-center gap-2 self-start rounded-md px-1 text-[12px] text-muted transition-colors duration-150 hover:text-ink md:min-h-8"
              >
                <HealthIcon health="available" className="h-2 w-2 shrink-0 text-ok" />
                <span className="tabular-nums">
                  {laneList.length} {laneList.length === 1 ? "lane" : "lanes"}, none short
                </span>
              </Link>
            )
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

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <h2 className="text-[11px] font-medium uppercase tracking-wide text-faint">{title}</h2>
      {children}
    </div>
  )
}

function Pill({ className, children }: { className: string; children: ReactNode }) {
  return (
    <span className={cx("inline-flex shrink-0 items-center rounded-full px-2 text-[11px] font-medium leading-[18px]", className)}>{children}</span>
  )
}

// One brief item: a face or icon, a one-line title, a status pill with the
// channel or lane in muted text, the age, and the one thing to do with it.
// The whole row is the link; the action is its visible label.
function ItemRow({
  lead,
  title,
  pill,
  meta,
  time,
  action,
  primary = false,
}: {
  lead: ReactNode
  title: ReactNode
  pill: ReactNode
  meta: ReactNode
  time: string
  action: string
  primary?: boolean
}) {
  return (
    <>
      <span className="shrink-0">{lead}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-ink">{title}</span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12px] text-muted">
          {pill}
          <span className="min-w-0 truncate">{meta}</span>
        </span>
      </span>
      {time && <span className="hidden shrink-0 text-[12px] tabular-nums text-faint sm:inline">{time}</span>}
      <span
        className={cx(
          "inline-flex min-h-7 shrink-0 items-center rounded-md px-2.5 text-[12px] font-medium transition-colors duration-150",
          primary ? "bg-accent text-canvas" : "border border-line text-ink group-hover:bg-surface",
        )}
      >
        {action}
      </span>
    </>
  )
}

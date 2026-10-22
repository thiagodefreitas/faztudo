import type { Approval, Channel, Lane, Member, Message, Run } from "../types"
import { runTime, ulidTime } from "./all-work"
import { formatClock } from "./time"
import { formatCountdown } from "./lane-format"

export const SEEN_KEY = "faztudo.today.seen"
export const OPEN_KEY = "faztudo.today.open"
/** How far back the first visit looks. */
export const FIRST_VISIT_MS = 12 * 60 * 60 * 1000

export type Outcome = "failed" | "waiting" | "merged" | "kept" | "discarded" | "no_changes" | "answer" | "cancelled"

export interface NeedItem {
  kind: "approval" | "question"
  id: string
  channelId: string
  channel: string
  /** Handle of the agent that asks, when known. */
  agent: string
  title: string
  /** Milliseconds since the epoch, undefined when unknown. */
  at: number | undefined
}

export interface FinishedItem {
  run: Run
  outcome: Outcome
  agent: string
  /** Why a failed run failed. */
  reason?: string
  at: number
}

export interface FinishedGroup {
  channelId: string
  channel: string
  items: FinishedItem[]
}

export interface RunningItem {
  run: Run
  agent: string
  channel: string
}

export interface LaneItem {
  id: string
  health: Lane["health"]
  /** Reset moment of the soonest future window, undefined when unknown. */
  resetsAt: number | undefined
  resetsToday: boolean
}

export interface Today {
  needs: NeedItem[]
  finished: FinishedGroup[]
  running: RunningItem[]
  lanes: LaneItem[]
}

export interface TodayInput {
  runs: Run[]
  approvals: Approval[]
  /** Agent messages that offer options and have no human answer yet. */
  questions: Message[]
  channels: Channel[]
  members: Member[]
  lanes: Lane[]
  seen: number
  now: number
}

/** The stored last-visit time, or the first-visit window when there is none. */
export function readSeen(now: number): number {
  try {
    const stored = Date.parse(localStorage.getItem(SEEN_KEY) ?? "")
    if (!Number.isNaN(stored)) return stored
  } catch {
    // Storage is blocked: behave like a first visit.
  }
  return now - FIRST_VISIT_MS
}

export function writeSeen(now: number): void {
  try {
    localStorage.setItem(SEEN_KEY, new Date(now).toISOString())
  } catch {
    // The mark lasts until the page closes only.
  }
}

export function readOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) !== "0"
  } catch {
    return true
  }
}

export function writeOpen(open: boolean): void {
  try {
    localStorage.setItem(OPEN_KEY, open ? "1" : "0")
  } catch {
    // The choice lasts until the page closes only.
  }
}

function outcomeOf(run: Run): Outcome | undefined {
  switch (run.state) {
    case "failed":
      return "failed"
    case "cancelled":
      return "cancelled"
    case "waiting_approval":
      return "waiting"
    case "done":
      if (run.mode !== "write") return "answer"
      if (run.approval_option === "keep") return "kept"
      if (run.approval_option === "discard") return "discarded"
      if (run.approval_option === "merge") return "merged"
      // A done write run with no decision found nothing to change.
      return "no_changes"
    default:
      return undefined
  }
}

function localDay(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

function laneItem(lane: Lane, now: number): LaneItem | undefined {
  let resetsAt: number | undefined
  for (const window of lane.windows) {
    const at = window.resets_at ? Date.parse(window.resets_at) : Number.NaN
    if (!Number.isNaN(at) && at > now && (resetsAt === undefined || at < resetsAt)) resetsAt = at
  }
  const resetsToday = resetsAt !== undefined && localDay(resetsAt) === localDay(now)
  const blocked = lane.health === "exhausted" || lane.health === "conserve"
  // A lane that is fine, or unmeasured, has nothing to say even if a window rolls over.
  const down = lane.health === "unavailable" && resetsToday
  if (!blocked && !down) return undefined
  return { id: lane.id, health: lane.health, resetsAt, resetsToday }
}

const LANE_ORDER: Record<string, number> = { exhausted: 0, conserve: 1 }

/** Text for the reset column: a clock time today, a countdown later, or unknown. */
export function resetLabel(item: LaneItem, now: number): string {
  if (item.resetsAt === undefined) return "reset unknown"
  if (item.resetsToday) return `resets ${formatClock(new Date(item.resetsAt).toISOString())}`
  return formatCountdown(new Date(item.resetsAt).toISOString(), now)
}

/** Everything the Today brief shows, from data the app already loads. */
export function buildToday(input: TodayInput): Today {
  const { runs, channels, members, now } = input
  const handle = (id: string) => members.find((member) => member.id === id)?.handle ?? id
  const channelName = (id: string) => channels.find((channel) => channel.id === id)?.name ?? "channel"

  const needs: NeedItem[] = []
  for (const approval of input.approvals) {
    if (approval.state !== "pending") continue
    const run = approval.run_id ? runs.find((item) => item.id === approval.run_id) : undefined
    needs.push({
      kind: "approval",
      id: approval.id,
      channelId: approval.channel_id,
      channel: channelName(approval.channel_id),
      agent: handle(run?.agent_id ?? approval.requested_by),
      title: approval.title,
      at: ulidTime(approval.id),
    })
  }
  for (const message of input.questions) {
    const at = Date.parse(message.created_at)
    needs.push({
      kind: "question",
      id: message.id,
      channelId: message.channel_id,
      channel: channelName(message.channel_id),
      agent: handle(message.author_id),
      title: message.body,
      at: Number.isNaN(at) ? ulidTime(message.id) : at,
    })
  }
  // Oldest first; an item of unknown age goes last.
  needs.sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity))

  const byChannel = new Map<string, FinishedItem[]>()
  for (const run of runs) {
    const outcome = outcomeOf(run)
    const at = runTime(run)
    if (!outcome || at === undefined || at <= input.seen) continue
    const item: FinishedItem = { run, outcome, agent: handle(run.agent_id), at }
    if (outcome === "failed") item.reason = run.failure_reason || run.failure_class || "no reason recorded"
    byChannel.set(run.channel_id, [...(byChannel.get(run.channel_id) ?? []), item])
  }
  const finished: FinishedGroup[] = [...byChannel].map(([channelId, items]) => ({
    channelId,
    channel: channelName(channelId),
    // Failed runs first, then the newest.
    items: items.sort((a, b) => Number(b.outcome === "failed") - Number(a.outcome === "failed") || b.at - a.at),
  }))
  const failedFirst = (group: FinishedGroup) => Number(group.items[0]?.outcome === "failed")
  finished.sort((a, b) => failedFirst(b) - failedFirst(a) || (b.items[0]?.at ?? 0) - (a.items[0]?.at ?? 0))

  const running = runs
    .filter((run) => run.state === "running" || run.state === "verifying" || run.state === "queued")
    .map((run) => ({ run, agent: handle(run.agent_id), channel: channelName(run.channel_id) }))
    .sort((a, b) => a.run.id.localeCompare(b.run.id))

  const lanes = input.lanes
    .map((lane) => laneItem(lane, now))
    .filter((item): item is LaneItem => item !== undefined)
    .sort((a, b) => (LANE_ORDER[a.health] ?? 2) - (LANE_ORDER[b.health] ?? 2) || a.id.localeCompare(b.id))

  return { needs, finished, running, lanes }
}

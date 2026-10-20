import { useQueryClient } from "@tanstack/react-query"
import { useSyncExternalStore } from "react"
import { identityOf } from "../../lib/avatar"
import { plainPreview } from "../../lib/inbox"
import { runRequestOf } from "../../lib/request"
import { useTheme, type ThemeChoice } from "../../lib/theme"
import { formatElapsed } from "../../lib/time"
import { qk } from "../../state/keys"
import { useNow } from "../../state/now"
import { useApprovals, useChannels, useLanes, useLastMessages, useMembers, useOrg, useRuns } from "../../state/queries"
import type { Approval, Channel, Department, ID, Lane, Member, Message, Org, Run, RunState } from "../../types"

export const FAIL_WINDOW_MS = 10 * 60 * 1000
export const DONE_WINDOW_MS = 10 * 60 * 1000

export type DeskState = "idle" | "working" | "queued" | "waiting_approval" | "failed" | "out_of_quota"

export type AgentHueKey = "claude" | "codex" | "agy" | "kimi" | "opencode" | "grok"

export interface AgentHuePalette {
  key: AgentHueKey
  name: string
  accent: string
  bg: string
  fg: string
  border: string
}

export const HUE_KEYS: readonly AgentHueKey[] = ["claude", "codex", "agy", "kimi", "opencode", "grok"] as const

export const AGENT_HUES: Record<ThemeChoice, Record<AgentHueKey, AgentHuePalette>> = {
  light: {
    claude: { key: "claude", name: "Cobalt", accent: "#1d5bbf", bg: "#e6effc", fg: "#143e82", border: "#acc8f7" },
    codex: { key: "codex", name: "Amber", accent: "#a85800", bg: "#fdf0de", fg: "#7a4000", border: "#f2c68a" },
    agy: { key: "agy", name: "Teal", accent: "#0e7c74", bg: "#dff3f0", fg: "#09504b", border: "#9ad9d1" },
    kimi: { key: "kimi", name: "Plum", accent: "#8f3270", bg: "#f9e8f3", fg: "#63204c", border: "#e3afd1" },
    opencode: { key: "opencode", name: "Sky", accent: "#0b729c", bg: "#e1f3fa", fg: "#074d6b", border: "#9bd5ed" },
    grok: { key: "grok", name: "Terracotta", accent: "#b83b1b", bg: "#fceae4", fg: "#7d2610", border: "#f2b6a5" },
  },
  dark: {
    claude: { key: "claude", name: "Cobalt", accent: "#5899f7", bg: "#142238", fg: "#9ec5fc", border: "#274675" },
    codex: { key: "codex", name: "Amber", accent: "#f09c38", bg: "#2b1f10", fg: "#f8c98c", border: "#5e411c" },
    agy: { key: "agy", name: "Teal", accent: "#2bb5a8", bg: "#102a28", fg: "#7ce3d8", border: "#1f544f" },
    kimi: { key: "kimi", name: "Plum", accent: "#d975b6", bg: "#2a1724", fg: "#f0b6dc", border: "#592e4b" },
    opencode: { key: "opencode", name: "Sky", accent: "#3eb4e6", bg: "#102630", fg: "#95dcf7", border: "#1f4e63" },
    grok: { key: "grok", name: "Terracotta", accent: "#ed7353", bg: "#2c1813", fg: "#f7b5a3", border: "#5e3024" },
  },
}

export const DESK_STATE_LABELS: Record<DeskState, string> = {
  idle: "idle",
  working: "working",
  queued: "queued",
  waiting_approval: "waiting for approval",
  failed: "failed",
  out_of_quota: "out of quota",
}

export interface DeskInfo {
  member: Member
  isDirector: boolean
  state: DeskState
  stateLabel: string
  hue: AgentHueKey
  palette: AgentHuePalette
  initial: string
  monogram: string
  lane: Lane | undefined
  laneId: string | undefined
  outOfQuota: boolean
  resetTimeText?: string | undefined
  doneRecently?: boolean | undefined
  currentRun: Run | null
  runTitle: string | undefined
  // The request behind the active run, whole, for the line under the name and the hover title.
  runRequest?: string | undefined
  pendingApproval: Approval | null
  approvalChannelId: ID | undefined
  elapsedText: string | undefined
  // The persona running on this raw CLI's lane, when the CLI itself is not.
  busyFor: Member | null
}

export interface DeriveMemberDeskInput {
  member: Member
  runs: Run[]
  approvals: Approval[]
  lanes: Lane[]
  triggerMessages?: ReadonlyMap<ID, string> | undefined
  now: number
  theme?: ThemeChoice
  members?: Member[]
}

export interface DeriveOfficeDesksInput {
  members: Member[]
  runs: Run[]
  approvals: Approval[]
  lanes: Lane[]
  triggerMessages?: ReadonlyMap<ID, string> | undefined
  now: number
  theme?: ThemeChoice
}

const ACTIVE_STATES = new Set<RunState>(["waiting_approval", "running", "verifying", "queued"])

function isHueKey(value: string | undefined): value is AgentHueKey {
  if (!value) return false
  return (HUE_KEYS as readonly string[]).includes(value)
}

export function resolveMemberHue(member: Member, lane?: Lane): AgentHueKey {
  const handle = member.handle.trim().toLowerCase()
  if (isHueKey(handle)) return handle
  for (const key of HUE_KEYS) {
    if (handle.startsWith(key)) return key
  }
  if (lane && isHueKey(lane.cli)) return lane.cli
  const configuredLane = member.agent?.lanes[0]
  if (configuredLane) {
    const prefix = configuredLane.split("/")[0]?.toLowerCase()
    if (isHueKey(prefix)) return prefix
  }
  if (member.kind === "human") return "agy"
  let hash = 0
  const seed = handle || member.id
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0
  }
  return HUE_KEYS[hash % HUE_KEYS.length] ?? "claude"
}

export function memberInitial(member: Member): string {
  const source = member.display_name.trim() || member.handle.trim() || "?"
  return (source[0] ?? "?").toUpperCase()
}

const HUE_MONOGRAM: Record<AgentHueKey, string> = {
  claude: "CL",
  codex: "CX",
  agy: "AG",
  kimi: "KM",
  opencode: "OC",
  grok: "GK",
}

export function memberMonogram(member: Member, hue: AgentHueKey): string {
  if (member.kind === "human") return memberInitial(member)
  const handle = member.handle.trim().toLowerCase()
  if (isHueKey(handle)) return HUE_MONOGRAM[handle]
  const clean = (member.display_name.trim() || member.handle.trim()).replace(/[^a-zA-Z0-9]/g, "").toUpperCase()
  if (clean.length >= 2) return clean.slice(0, 2)
  return HUE_MONOGRAM[hue]
}

function runTimestamp(run: Run): number {
  const raw = run.ended_at ?? run.started_at
  if (!raw) return -1
  const parsed = Date.parse(raw)
  return Number.isNaN(parsed) ? -1 : parsed
}

function pickLatestRun(candidates: Run[]): Run | null {
  if (candidates.length === 0) return null
  let best = candidates[0] ?? null
  let bestTime = best ? runTimestamp(best) : -1
  for (let i = 1; i < candidates.length; i += 1) {
    const candidate = candidates[i]
    if (!candidate) continue
    const time = runTimestamp(candidate)
    if (time > bestTime || (time === bestTime && time === -1) || time === bestTime) {
      best = candidate
      bestTime = time
    }
  }
  return best
}

const LANE_IN_USE = new Set<RunState>(["queued", "running", "verifying"])

// A raw CLI (claude, codex, ...) shares its lanes with the personas built on
// them. This returns the persona whose run is using one of the CLI's lanes
// right now, or null when the member is not a raw CLI or nobody borrows it.
export function laneBorrower(member: Member, runs: Run[], members: Member[]): Member | null {
  if (member.kind !== "agent" || identityOf(member).role !== null) return null
  const laneIds = new Set(member.agent?.lanes ?? [])
  if (laneIds.size === 0) return null
  const run = pickLatestRun(
    runs.filter((item) => item.agent_id !== member.id && laneIds.has(item.lane_id) && LANE_IN_USE.has(item.state)),
  )
  if (!run) return null
  const borrower = members.find((item) => item.id === run.agent_id)
  return borrower && borrower.kind === "agent" ? borrower : null
}

function isFailedWithinWindow(run: Run, now: number): boolean {
  if (run.state !== "failed") return false
  const raw = run.ended_at ?? run.started_at
  if (!raw) return true
  const at = Date.parse(raw)
  if (Number.isNaN(at)) return true
  return now - at <= FAIL_WINDOW_MS
}

export function isDoneWithinWindow(run: Run | null | undefined, now: number): boolean {
  if (!run || run.state !== "done") return false
  const raw = run.ended_at ?? run.started_at
  if (!raw) return true
  const at = Date.parse(raw)
  if (Number.isNaN(at)) return true
  return now - at >= 0 && now - at <= DONE_WINDOW_MS
}

export function formatResetTime(resetsAt: string | undefined): string | undefined {
  if (!resetsAt) return undefined
  const trimmed = resetsAt.trim()
  if (!trimmed) return undefined
  if (/^\d{1,2}:\d{2}(?:\s?[AP]M)?$/i.test(trimmed)) return trimmed
  const isoMatch = trimmed.match(/T(\d{2}:\d{2})/)
  if (isoMatch?.[1]) return isoMatch[1]
  const at = Date.parse(trimmed)
  if (Number.isNaN(at)) return undefined
  const date = new Date(at)
  return `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`
}


export { runRequestOf }

export function formatRunTitle(body: string | undefined, maxWords = 6, maxChars = 38): string | undefined {
  if (!body) return undefined
  // Strip leading @mention or /lane <cli/name> override so the task words come first.
  const cleaned = plainPreview(body)
    .replace(/^(?:@\S+\s+|\/lane\s+\S+\/\S+\s+)+/i, "")
    .trim()
  const source = cleaned || plainPreview(body)
  if (!source) return undefined
  const words = source.split(/\s+/)
  const joined = words.slice(0, maxWords).join(" ")
  const truncatedWords = words.length > maxWords ? `${joined}...` : joined
  if (truncatedWords.length <= maxChars) return truncatedWords
  return `${truncatedWords.slice(0, maxChars - 3).trimEnd()}...`
}

export function deriveMemberDesk({
  member,
  runs,
  approvals,
  lanes,
  triggerMessages,
  now,
  theme = "light",
  members = [],
}: DeriveMemberDeskInput): DeskInfo {
  const memberRuns = runs.filter((run) => run.agent_id === member.id)
  const memberRunIds = new Set(memberRuns.map((run) => run.id))

  // Match any pending approval requested by this member or linked to one of its runs.
  const pendingCandidates = approvals.filter(
    (approval) =>
      approval.state === "pending" &&
      (approval.requested_by === member.id || (approval.run_id !== undefined && memberRunIds.has(approval.run_id))),
  )
  const pendingApproval = pendingCandidates.at(-1) ?? null

  const waitingRuns = memberRuns.filter(
    (run) => run.state === "waiting_approval" || (pendingApproval?.run_id !== undefined && run.id === pendingApproval.run_id),
  )
  const workingRuns = memberRuns.filter((run) => run.state === "running" || run.state === "verifying")
  const queuedRuns = memberRuns.filter((run) => run.state === "queued")
  const terminalRuns = memberRuns.filter((run) => !ACTIVE_STATES.has(run.state))

  const waitingRun = pickLatestRun(waitingRuns)
  const workingRun = pickLatestRun(workingRuns)
  const queuedRun = pickLatestRun(queuedRuns)
  const lastTerminalRun = pickLatestRun(terminalRuns)

  const activeRun = waitingRun ?? workingRun ?? queuedRun
  const currentRun = activeRun ?? lastTerminalRun

  const primaryLaneId = activeRun?.lane_id ?? member.agent?.lanes[0] ?? lastTerminalRun?.lane_id
  const lane = primaryLaneId ? lanes.find((item) => item.id === primaryLaneId) : undefined
  const outOfQuota = lane?.health === "exhausted" || lane?.health === "unavailable"
  const resetWindow = lane?.windows.find((w) => Boolean(w.resets_at))
  const resetTimeText = formatResetTime(resetWindow?.resets_at)

  let state: DeskState = "idle"
  if (pendingApproval !== null || waitingRun !== null) {
    state = "waiting_approval"
  } else if (workingRun !== null) {
    state = "working"
  } else if (queuedRun !== null) {
    state = "queued"
  } else if (lastTerminalRun !== null && isFailedWithinWindow(lastTerminalRun, now)) {
    state = "failed"
  } else if (outOfQuota) {
    state = "out_of_quota"
  }

  const busyFor = state === "idle" ? laneBorrower(member, runs, members) : null
  const doneRecently = state === "idle" && busyFor === null && isDoneWithinWindow(lastTerminalRun, now)

  const hue = resolveMemberHue(member, lane)
  const palette = AGENT_HUES[theme][hue]
  const approvalChannelId = pendingApproval?.channel_id ?? waitingRun?.channel_id
  const elapsedText =
    state === "working" && workingRun ? formatElapsed(workingRun.started_at, undefined, now) : undefined
  const triggerBody = currentRun ? triggerMessages?.get(currentRun.trigger_message_id) : undefined
  const runTitle = formatRunTitle(triggerBody) ?? (pendingApproval ? formatRunTitle(pendingApproval.title) : undefined)

  return {
    member,
    isDirector: member.kind === "human",
    state,
    stateLabel: DESK_STATE_LABELS[state],
    hue,
    palette,
    initial: memberInitial(member),
    monogram: memberMonogram(member, hue),
    lane,
    laneId: lane?.id ?? primaryLaneId,
    outOfQuota,
    resetTimeText,
    doneRecently,
    currentRun,
    runTitle,
    runRequest: runRequestOf(triggerBody),
    pendingApproval,
    approvalChannelId,
    elapsedText,
    busyFor,
  }
}

export function deriveOfficeDesks({
  members,
  runs,
  approvals,
  lanes,
  triggerMessages,
  now,
  theme = "light",
}: DeriveOfficeDesksInput): DeskInfo[] {
  const derived = members.map((member) =>
    deriveMemberDesk({
      member,
      runs,
      approvals,
      lanes,
      triggerMessages,
      now,
      theme,
      members,
    }),
  )
  // Director (human) desks sit at the front of the room, followed by agent desks.
  const directors = derived.filter((desk) => desk.isDirector)
  const agents = derived.filter((desk) => !desk.isDirector)
  return [...directors, ...agents]
}

export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (listener) => {
      if (typeof matchMedia !== "function") return () => undefined
      const media = matchMedia("(prefers-reduced-motion: reduce)")
      media.addEventListener?.("change", listener)
      return () => media.removeEventListener?.("change", listener)
    },
    () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => false,
  )
}

export function useOfficeDesks(): {
  desks: DeskInfo[]
  channels: Channel[]
  lanes: Lane[]
  runs: Run[]
  members: Member[]
  org: Org | undefined
  departments: Department[]
  isPending: boolean
  now: number
  theme: ThemeChoice
} {
  const qc = useQueryClient()
  const members = useMembers()
  const runs = useRuns()
  const approvals = useApprovals()
  const lanes = useLanes()
  const channels = useChannels()
  const org = useOrg()
  const now = useNow()
  const { choice: theme } = useTheme()

  const runList = runs.data ?? []
  const laneList = lanes.data ?? []
  const memberList = members.data ?? []
  const activeChannelIds = [
    ...new Set(
      runList
        .filter((run) => ACTIVE_STATES.has(run.state))
        .map((run) => run.channel_id),
    ),
  ]
  // Ensure active channels' messages are fetched so trigger message bodies are available.
  useLastMessages(activeChannelIds)

  const triggerMessages = new Map<ID, string>()
  const channelIds = new Set<ID>([
    ...(channels.data ?? []).map((c) => c.id),
    ...runList.map((r) => r.channel_id),
  ])
  for (const chId of channelIds) {
    const msgs = qc.getQueryData<Message[]>(qk.messages(chId))
    if (!msgs) continue
    for (const msg of msgs) {
      triggerMessages.set(msg.id, msg.body)
    }
  }

  const desks = deriveOfficeDesks({
    members: memberList,
    runs: runList,
    approvals: approvals.data ?? [],
    lanes: laneList,
    triggerMessages,
    now,
    theme,
  })

  return {
    desks,
    channels: channels.data ?? [],
    lanes: laneList,
    runs: runList,
    members: memberList,
    org: org.data,
    departments: org.data?.departments ?? [],
    isPending: members.isPending && memberList.length === 0,
    now,
    theme,
  }
}

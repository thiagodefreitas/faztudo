import { useSyncExternalStore } from "react"
import { useTheme, type ThemeChoice } from "../../lib/theme"
import { formatElapsed } from "../../lib/time"
import { useNow } from "../../state/now"
import { useApprovals, useChannels, useLanes, useMembers, useRuns } from "../../state/queries"
import type { Approval, Channel, ID, Lane, Member, Run, RunState } from "../../types"

export const FAIL_WINDOW_MS = 10 * 60 * 1000

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
  currentRun: Run | null
  pendingApproval: Approval | null
  approvalChannelId: ID | undefined
  elapsedText: string | undefined
}

export interface DeriveMemberDeskInput {
  member: Member
  runs: Run[]
  approvals: Approval[]
  lanes: Lane[]
  now: number
  theme?: ThemeChoice
}

export interface DeriveOfficeDesksInput {
  members: Member[]
  runs: Run[]
  approvals: Approval[]
  lanes: Lane[]
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

function isFailedWithinWindow(run: Run, now: number): boolean {
  if (run.state !== "failed") return false
  const raw = run.ended_at ?? run.started_at
  if (!raw) return true
  const at = Date.parse(raw)
  if (Number.isNaN(at)) return true
  return now - at <= FAIL_WINDOW_MS
}

export function deriveMemberDesk({
  member,
  runs,
  approvals,
  lanes,
  now,
  theme = "light",
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

  const hue = resolveMemberHue(member, lane)
  const palette = AGENT_HUES[theme][hue]
  const approvalChannelId = pendingApproval?.channel_id ?? waitingRun?.channel_id
  const elapsedText =
    state === "working" && workingRun ? formatElapsed(workingRun.started_at, undefined, now) : undefined

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
    currentRun,
    pendingApproval,
    approvalChannelId,
    elapsedText,
  }
}

export function deriveOfficeDesks({
  members,
  runs,
  approvals,
  lanes,
  now,
  theme = "light",
}: DeriveOfficeDesksInput): DeskInfo[] {
  const derived = members.map((member) =>
    deriveMemberDesk({
      member,
      runs,
      approvals,
      lanes,
      now,
      theme,
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
  isPending: boolean
  now: number
  theme: ThemeChoice
} {
  const members = useMembers()
  const runs = useRuns()
  const approvals = useApprovals()
  const lanes = useLanes()
  const channels = useChannels()
  const now = useNow()
  const { choice: theme } = useTheme()

  const desks = deriveOfficeDesks({
    members: members.data ?? [],
    runs: runs.data ?? [],
    approvals: approvals.data ?? [],
    lanes: lanes.data ?? [],
    now,
    theme,
  })

  return {
    desks,
    channels: channels.data ?? [],
    isPending: members.isPending && (members.data ?? []).length === 0,
    now,
    theme,
  }
}

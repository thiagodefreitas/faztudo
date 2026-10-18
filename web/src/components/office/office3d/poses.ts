import { identityOf, type Cli, type Role } from "../../../lib/avatar"
import { displayPct } from "../../../lib/lane-format"
import { primaryWindow } from "../../../lib/lanes"
import type { ThemeChoice } from "../../../lib/theme"
import type { ID, Lane, LaneHealth } from "../../../types"
import { AGENT_HUES, type AgentHueKey, type DeskInfo, formatResetTime } from "../state"

export type CharacterCli = Cli | "unknown" | "director"

export type HeadSilhouette =
  | "round_one_antenna"
  | "square_visor"
  | "round_pointed_ears"
  | "one_big_eye"
  | "square_side_bolts"
  | "wide_two_antennae"
  | "neutral"
  | "human"

export type PinMotif = "</>" | "magnifier" | "compass" | "quill" | "dot"

export interface CharacterIdentity {
  cli: CharacterCli
  headSilhouette: HeadSilhouette
  isDirector: boolean
  rolePin: Role | null
  pinMotif: PinMotif | null
  hue: AgentHueKey
  mainColor: string
  softColor: string
  fgColor: string
}

const CLI_SILHOUETTE: Record<Cli | "unknown", HeadSilhouette> = {
  claude: "round_one_antenna",
  codex: "square_visor",
  agy: "round_pointed_ears",
  kimi: "one_big_eye",
  opencode: "square_side_bolts",
  grok: "wide_two_antennae",
  unknown: "neutral",
}

const ROLE_PIN_MOTIF: Record<Role, PinMotif> = {
  coder: "</>",
  reviewer: "magnifier",
  architect: "compass",
  writer: "quill",
  other: "dot",
}

export function rolePinMotif(role: Role | null | undefined): PinMotif | null {
  if (!role) return null
  return ROLE_PIN_MOTIF[role] ?? "dot"
}

export function deriveCharacterIdentity(desk: DeskInfo, theme: ThemeChoice = "light"): CharacterIdentity {
  if (desk.isDirector || desk.member.kind === "human") {
    const accent = theme === "dark" ? "#5cd6c8" : "#0e7c74"
    const soft = theme === "dark" ? "#153533" : "#dff3f0"
    const fg = theme === "dark" ? "#edf2f4" : "#11181c"
    return {
      cli: "director",
      headSilhouette: "human",
      isDirector: true,
      rolePin: null,
      pinMotif: null,
      hue: desk.hue,
      mainColor: accent,
      softColor: soft,
      fgColor: fg,
    }
  }

  const identity = identityOf(desk.member)
  const cli: Cli | "unknown" = identity.cli ?? "unknown"
  const rolePin = identity.role
  const huePalette = AGENT_HUES[theme][desk.hue] ?? desk.palette

  return {
    cli,
    headSilhouette: CLI_SILHOUETTE[cli],
    isDirector: false,
    rolePin,
    pinMotif: rolePinMotif(rolePin),
    hue: desk.hue,
    mainColor: huePalette.accent,
    softColor: huePalette.bg,
    fgColor: huePalette.fg,
  }
}

export type CharacterPoseName =
  | "working"
  | "queued"
  | "waiting_approval"
  | "failed"
  | "done_recently"
  | "idle"
  | "out_of_quota"
  | "busy_for_persona"

export type ArmPose = "typing" | "raised" | "stretch" | "slumped" | "rest"

export type MonitorMode = "glow" | "clock" | "approval" | "error" | "persona_badge" | "dim" | "off"

export interface CharacterPose {
  pose: CharacterPoseName
  seated: boolean
  animated: boolean
  torsoLean: number
  headPitch: number
  headYaw: number
  leftArm: ArmPose
  rightArm: ArmPose
  monitorMode: MonitorMode
  monitorGlowHue: string | null
  showApprovalCard: boolean
  showRedLamp: boolean
  quotaNote: string | null
  personaBadgeRole: Role | null
  personaBadgeMotif: PinMotif | null
  personaHandle: string | null
  canDoze: boolean
}

export interface DeriveCharacterPoseOptions {
  reducedMotion?: boolean | undefined
}

export function deriveCharacterPose(desk: DeskInfo, options?: DeriveCharacterPoseOptions): CharacterPose {
  const reducedMotion = Boolean(options?.reducedMotion)
  const { state, palette, doneRecently, busyFor, lane, resetTimeText } = desk

  let pose: CharacterPoseName = "idle"
  if (state === "working") {
    pose = "working"
  } else if (state === "queued") {
    pose = "queued"
  } else if (state === "waiting_approval") {
    pose = "waiting_approval"
  } else if (state === "failed") {
    pose = "failed"
  } else if (state === "out_of_quota") {
    pose = "out_of_quota"
  } else if (busyFor !== null) {
    pose = "busy_for_persona"
  } else if (doneRecently) {
    pose = "done_recently"
  }

  switch (pose) {
    case "working":
      return {
        pose: "working",
        seated: true,
        animated: !reducedMotion,
        torsoLean: 0.12,
        headPitch: 0.08,
        headYaw: 0,
        leftArm: "typing",
        rightArm: "typing",
        monitorMode: "glow",
        monitorGlowHue: palette.accent,
        showApprovalCard: false,
        showRedLamp: false,
        quotaNote: null,
        personaBadgeRole: null,
        personaBadgeMotif: null,
        personaHandle: null,
        canDoze: false,
      }
    case "queued":
      return {
        pose: "queued",
        seated: true,
        animated: false,
        torsoLean: 0,
        headPitch: 0,
        headYaw: 0,
        leftArm: "rest",
        rightArm: "rest",
        monitorMode: "clock",
        monitorGlowHue: null,
        showApprovalCard: false,
        showRedLamp: false,
        quotaNote: null,
        personaBadgeRole: null,
        personaBadgeMotif: null,
        personaHandle: null,
        canDoze: false,
      }
    case "waiting_approval":
      return {
        pose: "waiting_approval",
        seated: true,
        animated: !reducedMotion,
        torsoLean: 0.03,
        headPitch: -0.06,
        headYaw: 0,
        leftArm: "rest",
        rightArm: "raised",
        monitorMode: "approval",
        monitorGlowHue: null,
        showApprovalCard: true,
        showRedLamp: false,
        quotaNote: null,
        personaBadgeRole: null,
        personaBadgeMotif: null,
        personaHandle: null,
        canDoze: false,
      }
    case "failed":
      return {
        pose: "failed",
        seated: true,
        animated: false,
        torsoLean: 0.36,
        headPitch: 0.42,
        headYaw: -0.08,
        leftArm: "slumped",
        rightArm: "slumped",
        monitorMode: "error",
        monitorGlowHue: null,
        showApprovalCard: false,
        showRedLamp: true,
        quotaNote: null,
        personaBadgeRole: null,
        personaBadgeMotif: null,
        personaHandle: null,
        canDoze: false,
      }
    case "done_recently":
      return {
        pose: "done_recently",
        seated: true,
        animated: !reducedMotion,
        torsoLean: -0.2,
        headPitch: -0.14,
        headYaw: 0,
        leftArm: "stretch",
        rightArm: "stretch",
        monitorMode: "dim",
        monitorGlowHue: null,
        showApprovalCard: false,
        showRedLamp: false,
        quotaNote: null,
        personaBadgeRole: null,
        personaBadgeMotif: null,
        personaHandle: null,
        canDoze: false,
      }
    case "out_of_quota": {
      const windowReset = resetTimeText ?? formatResetTime(lane?.windows.find((w) => Boolean(w.resets_at))?.resets_at)
      return {
        pose: "out_of_quota",
        seated: false,
        animated: false,
        torsoLean: 0,
        headPitch: 0,
        headYaw: 0,
        leftArm: "rest",
        rightArm: "rest",
        monitorMode: "off",
        monitorGlowHue: null,
        showApprovalCard: false,
        showRedLamp: false,
        quotaNote: windowReset ? `back at ${windowReset}` : "out of quota",
        personaBadgeRole: null,
        personaBadgeMotif: null,
        personaHandle: null,
        canDoze: false,
      }
    }
    case "busy_for_persona": {
      const role = busyFor ? (identityOf(busyFor).role ?? "other") : "other"
      return {
        pose: "busy_for_persona",
        seated: true,
        animated: false,
        torsoLean: 0.04,
        headPitch: 0.03,
        headYaw: 0,
        leftArm: "rest",
        rightArm: "rest",
        monitorMode: "persona_badge",
        monitorGlowHue: null,
        showApprovalCard: false,
        showRedLamp: false,
        quotaNote: null,
        personaBadgeRole: role,
        personaBadgeMotif: rolePinMotif(role),
        personaHandle: busyFor?.handle ?? null,
        canDoze: false,
      }
    }
    case "idle":
    default:
      return {
        pose: "idle",
        seated: true,
        animated: !reducedMotion,
        torsoLean: 0,
        headPitch: 0,
        headYaw: 0,
        leftArm: "rest",
        rightArm: "rest",
        monitorMode: "dim",
        monitorGlowHue: null,
        showApprovalCard: false,
        showRedLamp: false,
        quotaNote: null,
        personaBadgeRole: null,
        personaBadgeMotif: null,
        personaHandle: null,
        canDoze: !reducedMotion,
      }
  }
}

export interface CharacterFrameSample {
  torsoLean: number
  headPitch: number
  headYaw: number
  leftHandOffsetY: number
  rightHandOffsetY: number
  dozing: boolean
  breath: number
}

// One short look to the side per 12s cycle, outside the doze window (8.5-11.2).
function idleLookYaw(phase: number): number {
  const cycle = ((phase % 12) + 12) % 12
  if (cycle < 3 || cycle > 4.4) return 0
  const t = (cycle - 3) / 1.4
  const envelope = Math.sin(Math.PI * t)
  const dir = Math.floor(phase / 12) % 2 === 0 ? 1 : -1
  return dir * envelope * 0.4
}

function idleBreath(phase: number): number {
  return Math.sin(phase * 1.6) * 0.02
}

export function sampleCharacterFrame(pose: CharacterPose, elapsedSec: number, seed = 0): CharacterFrameSample {
  if (!pose.animated || !pose.seated) {
    return {
      torsoLean: pose.torsoLean,
      headPitch: pose.headPitch,
      headYaw: pose.headYaw,
      leftHandOffsetY: 0,
      rightHandOffsetY: 0,
      dozing: false,
      breath: 0,
    }
  }

  const phase = elapsedSec + (seed % 13) * 0.7
  if (pose.pose === "working") {
    return {
      torsoLean: pose.torsoLean + Math.sin(phase * 3.5) * 0.02,
      headPitch: pose.headPitch + Math.sin(phase * 2.2) * 0.02,
      headYaw: Math.sin(phase * 1.1) * 0.04,
      leftHandOffsetY: Math.sin(phase * 11) * 0.025,
      rightHandOffsetY: Math.cos(phase * 11) * 0.025,
      dozing: false,
      breath: 0,
    }
  }

  if (pose.pose === "waiting_approval") {
    return {
      torsoLean: pose.torsoLean,
      headPitch: pose.headPitch,
      headYaw: Math.sin(phase * 1.4) * 0.05,
      leftHandOffsetY: 0,
      rightHandOffsetY: Math.sin(phase * 3.2) * 0.02,
      dozing: false,
      breath: 0,
    }
  }

  if (pose.pose === "done_recently") {
    return {
      torsoLean: pose.torsoLean + Math.sin(phase * 1.8) * 0.04,
      headPitch: pose.headPitch,
      headYaw: Math.sin(phase * 1.2) * 0.06,
      leftHandOffsetY: Math.sin(phase * 1.8) * 0.02,
      rightHandOffsetY: Math.sin(phase * 1.8) * 0.02,
      dozing: false,
      breath: 0,
    }
  }

  // Idle: alternates between looking around and an occasional brief doze.
  const cycle = ((phase % 12) + 12) % 12
  const dozing = pose.canDoze && cycle >= 8.5 && cycle <= 11.2
  if (dozing) {
    return {
      torsoLean: 0.14,
      headPitch: 0.28,
      headYaw: 0,
      leftHandOffsetY: 0,
      rightHandOffsetY: 0,
      dozing: true,
      breath: idleBreath(phase),
    }
  }

  return {
    torsoLean: pose.torsoLean,
    headPitch: pose.headPitch,
    headYaw: idleLookYaw(phase),
    leftHandOffsetY: 0,
    rightHandOffsetY: 0,
    dozing: false,
    breath: idleBreath(phase),
  }
}

export interface TaskBoardNote {
  id: ID
  memberId: ID
  handle: string
  hue: AgentHueKey
  accent: string
  bg: string
  title: string
}

const ACTIVE_DESK_STATES = new Set(["working", "queued", "waiting_approval"])

export function deriveTaskBoardNotes(desks: DeskInfo[]): TaskBoardNote[] {
  const notes: TaskBoardNote[] = []
  for (const desk of desks) {
    if (!ACTIVE_DESK_STATES.has(desk.state) && !desk.currentRun) continue
    const run = desk.currentRun
    const isActiveDesk = ACTIVE_DESK_STATES.has(desk.state)
    const isActiveRun =
      run !== null &&
      (run.state === "running" || run.state === "verifying" || run.state === "queued" || run.state === "waiting_approval")
    if (!isActiveDesk && !isActiveRun) continue
    const title = desk.runTitle ?? desk.pendingApproval?.title ?? desk.stateLabel
    notes.push({
      id: run?.id ?? desk.member.id,
      memberId: desk.member.id,
      handle: desk.member.handle,
      hue: desk.hue,
      accent: desk.palette.accent,
      bg: desk.palette.bg,
      title,
    })
  }
  return notes
}

export interface LaneMeterBar {
  id: string
  health: LaneHealth
  color: string
  fillRatio: number
}

const HEALTH_COLOR_LIGHT: Record<LaneHealth, string> = {
  available: "#15803d",
  conserve: "#8a4b08",
  exhausted: "#b42318",
  unavailable: "#b42318",
  unknown: "#576670",
}

const HEALTH_COLOR_DARK: Record<LaneHealth, string> = {
  available: "#4ade80",
  conserve: "#f5b942",
  exhausted: "#f97066",
  unavailable: "#f97066",
  unknown: "#84949e",
}

export function deriveLaneMeterBars(lanes: Lane[], theme: ThemeChoice = "light"): LaneMeterBar[] {
  const colors = theme === "dark" ? HEALTH_COLOR_DARK : HEALTH_COLOR_LIGHT
  return lanes.map((lane) => {
    const win = primaryWindow(lane)
    const pct = win ? displayPct(win, lane.health) : undefined
    let fillRatio = 0.5
    if (pct !== undefined) {
      fillRatio = Math.min(1, Math.max(0.12, pct / 100))
    } else if (lane.health === "exhausted" || lane.health === "unavailable") {
      fillRatio = 1
    } else if (lane.capacity > 0) {
      fillRatio = Math.min(1, Math.max(0.18, lane.running / lane.capacity))
    }
    return {
      id: lane.id,
      health: lane.health,
      color: colors[lane.health],
      fillRatio,
    }
  })
}

export type DayPeriod = "day" | "twilight" | "night"

export interface TimeOfDayLighting {
  period: DayPeriod
  hour: number
  hemiSky: string
  hemiGround: string
  keyLight: string
  hemiIntensity: number
  keyIntensity: number
  sunPosition: [number, number, number]
  windowGlow: string
}

export function deriveTimeOfDayLighting(now: number, theme: ThemeChoice = "light"): TimeOfDayLighting {
  const date = new Date(now)
  const hour = Number.isNaN(date.getTime()) ? 12 : date.getHours()
  let period: DayPeriod = "day"
  if (hour < 6 || hour >= 20) {
    period = "night"
  } else if (hour < 8 || hour >= 18) {
    period = "twilight"
  }

  if (period === "day") {
    return theme === "dark"
      ? {
          period: "day",
          hour,
          hemiSky: "#d7e6f0",
          hemiGround: "#1f2a32",
          keyLight: "#f4f9fc",
          hemiIntensity: 1.55,
          keyIntensity: 1.3,
          sunPosition: [7, 15, 9],
          windowGlow: "#7dd3fc",
        }
      : {
          period: "day",
          hour,
          hemiSky: "#ffffff",
          hemiGround: "#dfe6eb",
          keyLight: "#fffdf8",
          hemiIntensity: 1.38,
          keyIntensity: 1.18,
          sunPosition: [7, 15, 9],
          windowGlow: "#bae6fd",
        }
  }

  if (period === "twilight") {
    return theme === "dark"
      ? {
          period: "twilight",
          hour,
          hemiSky: "#f6c18b",
          hemiGround: "#1e272e",
          keyLight: "#fdba74",
          hemiIntensity: 1.35,
          keyIntensity: 1.1,
          sunPosition: [-9, 11, 8],
          windowGlow: "#fb923c",
        }
      : {
          period: "twilight",
          hour,
          hemiSky: "#fff1e0",
          hemiGround: "#dce4ea",
          keyLight: "#fed7aa",
          hemiIntensity: 1.25,
          keyIntensity: 1.02,
          sunPosition: [-9, 11, 8],
          windowGlow: "#fdba74",
        }
  }

  // Night: cooler sky, warm studio interior fill so desks remain readable.
  return theme === "dark"
    ? {
        period: "night",
        hour,
        hemiSky: "#93b4d4",
        hemiGround: "#18222a",
        keyLight: "#cbd5e1",
        hemiIntensity: 1.22,
        keyIntensity: 0.88,
        sunPosition: [-5, 13, -7],
        windowGlow: "#1e3a8a",
      }
    : {
        period: "night",
        hour,
        hemiSky: "#dbeafe",
        hemiGround: "#d5dee6",
        keyLight: "#e2e8f0",
        hemiIntensity: 1.15,
        keyIntensity: 0.9,
        sunPosition: [-5, 13, -7],
        windowGlow: "#3b82f6",
      }
}

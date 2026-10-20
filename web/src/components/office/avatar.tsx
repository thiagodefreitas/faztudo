import type { ThemeChoice } from "../../lib/theme"
import type { AvatarState } from "../agent-avatar"
import {
  type ArmPose,
  type CharacterIdentity,
  type CharacterPose,
  type CharacterPoseName,
  deriveCharacterIdentity,
  deriveCharacterPose,
  deriveLaneMeterBars,
  deriveTaskBoardNotes,
  type HeadSilhouette,
  type LaneMeterBar,
  type MonitorMode,
  type PinMotif,
  rolePinMotif,
  sampleCharacterFrame,
  type TaskBoardNote,
} from "./office3d/poses"
import type { DeskInfo, DeskState } from "./state"

export {
  type ArmPose,
  type CharacterIdentity,
  type CharacterPose,
  type CharacterPoseName,
  deriveCharacterIdentity,
  deriveCharacterPose,
  deriveLaneMeterBars,
  deriveTaskBoardNotes,
  type HeadSilhouette,
  type LaneMeterBar,
  type MonitorMode,
  type PinMotif,
  rolePinMotif,
  sampleCharacterFrame,
  type TaskBoardNote,
}

// The office draws members with the shared AgentAvatar in the detail panel;
// this maps a desk state to the avatar's ring.
export function avatarState(state: DeskState): AvatarState | undefined {
  switch (state) {
    case "working":
      return "working"
    case "waiting_approval":
      return "waiting"
    case "failed":
      return "failed"
    case "out_of_quota":
      return "off"
    default:
      return undefined
  }
}

export interface Point2D {
  x: number
  y: number
}

export type FigureKind = "human" | "agent"

export interface Character2DView {
  figure: FigureKind
  initials: string
  identity: CharacterIdentity
  pose: CharacterPose
  facing: "up" | "down"
  seated: boolean
  headCenter: Point2D
  torsoRect: { x: number; y: number; w: number; h: number }
  leftShoulder: Point2D
  rightShoulder: Point2D
  leftHand: Point2D
  rightHand: Point2D
  eyesClosed: boolean
  idleGlance: boolean
}

export function directorInitials(name: string, fallback = "D"): string {
  const parts = name
    .trim()
    .split(/\s+/)
    .map((part) => part.replace(/[^a-zA-Z0-9]/g, ""))
    .filter((part) => part.length > 0)
  if (parts.length >= 2) {
    return `${parts[0]![0]!}${parts[parts.length - 1]![0]!}`.toUpperCase()
  }
  if (parts.length === 1) {
    const word = parts[0]!
    return (word.length >= 2 ? word.slice(0, 2) : word.slice(0, 1)).toUpperCase()
  }
  return fallback.slice(0, 2).toUpperCase() || "D"
}

function handCoordsForArm(
  side: "left" | "right",
  armPose: ArmPose,
  faceUp: boolean,
  figure: FigureKind,
): Point2D {
  const isLeft = side === "left"
  if (faceUp) {
    switch (armPose) {
      case "typing":
        return { x: isLeft ? 52 : 68, y: 36 }
      case "raised":
        return isLeft ? { x: 44, y: 58 } : { x: 80, y: 36 }
      case "stretch":
        return { x: isLeft ? 37 : 83, y: 38 }
      case "slumped":
        return { x: isLeft ? 49 : 71, y: 46 }
      case "rest":
      default:
        // The human Director sits relaxed, hands resting by the torso.
        if (figure === "human") {
          return { x: isLeft ? 47 : 73, y: 69 }
        }
        return { x: isLeft ? 44 : 76, y: 58 }
    }
  }

  switch (armPose) {
    case "typing":
      return { x: isLeft ? 52 : 68, y: 56 }
    case "raised":
      return isLeft ? { x: 44, y: 35 } : { x: 80, y: 7 }
    case "stretch":
      return { x: isLeft ? 37 : 83, y: 9 }
    case "slumped":
      return { x: isLeft ? 49 : 71, y: 42 }
    case "rest":
    default:
      if (figure === "human") {
        return { x: isLeft ? 48 : 72, y: 52 }
      }
      return { x: isLeft ? 44 : 76, y: 35 }
  }
}

export const DIRECTOR_TYPING_WINDOW_MS = 60 * 1000

// Builds the 2D flat character geometry in the 120x108 desk coordinate space
// from the shared 3D character identity and state-to-pose mapping.
export function derive2DCharacterView(
  desk: DeskInfo,
  options?: {
    theme?: ThemeChoice | undefined
    reducedMotion?: boolean | undefined
    facing?: "up" | "down" | undefined
    lastMessageAt?: number | string | undefined
    now?: number | undefined
  },
): Character2DView {
  const theme = options?.theme ?? "light"
  const reducedMotion = Boolean(options?.reducedMotion)
  const facing = options?.facing ?? (desk.isDirector ? "up" : "down")
  const faceUp = facing === "up"
  const figure: FigureKind = desk.isDirector || desk.member.kind === "human" ? "human" : "agent"

  let effectiveDesk = desk
  if (figure === "human" && desk.state === "idle" && options?.lastMessageAt !== undefined) {
    const raw = options.lastMessageAt
    const msgTime = typeof raw === "number" ? raw : Date.parse(raw)
    const refNow = options.now ?? Date.now()
    if (!Number.isNaN(msgTime) && refNow - msgTime >= 0 && refNow - msgTime <= DIRECTOR_TYPING_WINDOW_MS) {
      effectiveDesk = { ...desk, state: "working", stateLabel: "working" }
    }
  }

  const identity = deriveCharacterIdentity(effectiveDesk, theme)
  const pose = deriveCharacterPose(effectiveDesk, { reducedMotion })
  const initials = figure === "human" ? directorInitials(desk.member.display_name || desk.member.handle, desk.initial) : desk.monogram

  const baseHeadY = faceUp ? 50 : 15
  const baseTorsoY = faceUp ? 57 : 23
  const headOffsetY =
    pose.pose === "failed" ? (faceUp ? -4 : 4) : pose.pose === "done_recently" ? (faceUp ? 2 : -2) : 0
  const torsoOffsetY =
    pose.pose === "failed" ? (faceUp ? -2 : 2) : pose.pose === "done_recently" ? (faceUp ? 1 : -1) : 0

  const torsoY = baseTorsoY + torsoOffsetY
  const shoulderY = torsoY + 5

  return {
    figure,
    initials,
    identity,
    pose,
    facing,
    // An agent out of quota keeps its seat and its face; the desk dims it.
    seated: pose.seated || pose.pose === "out_of_quota",
    headCenter: { x: 60, y: baseHeadY + headOffsetY },
    torsoRect: { x: 45, y: torsoY, w: 30, h: 15 },
    leftShoulder: { x: 46, y: shoulderY },
    rightShoulder: { x: 74, y: shoulderY },
    leftHand: handCoordsForArm("left", pose.leftArm, faceUp, figure),
    rightHand: handCoordsForArm("right", pose.rightArm, faceUp, figure),
    eyesClosed: pose.pose === "failed",
    idleGlance: pose.pose === "idle" && pose.animated,
  }
}

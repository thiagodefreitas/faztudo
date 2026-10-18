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

export interface Character2DView {
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

function handCoordsForArm(
  side: "left" | "right",
  armPose: ArmPose,
  faceUp: boolean,
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
      return { x: isLeft ? 44 : 76, y: 35 }
  }
}

// Builds the 2D flat character geometry in the 120x108 desk coordinate space
// from the shared 3D character identity and state-to-pose mapping.
export function derive2DCharacterView(
  desk: DeskInfo,
  options?: {
    theme?: ThemeChoice | undefined
    reducedMotion?: boolean | undefined
    facing?: "up" | "down" | undefined
  },
): Character2DView {
  const theme = options?.theme ?? "light"
  const reducedMotion = Boolean(options?.reducedMotion)
  const facing = options?.facing ?? (desk.isDirector ? "up" : "down")
  const faceUp = facing === "up"

  const identity = deriveCharacterIdentity(desk, theme)
  const pose = deriveCharacterPose(desk, { reducedMotion })

  const baseHeadY = faceUp ? 50 : 15
  const baseTorsoY = faceUp ? 57 : 23
  const headOffsetY =
    pose.pose === "failed" ? (faceUp ? -4 : 4) : pose.pose === "done_recently" ? (faceUp ? 2 : -2) : 0
  const torsoOffsetY =
    pose.pose === "failed" ? (faceUp ? -2 : 2) : pose.pose === "done_recently" ? (faceUp ? 1 : -1) : 0

  const torsoY = baseTorsoY + torsoOffsetY
  const shoulderY = torsoY + 5

  return {
    identity,
    pose,
    facing,
    seated: pose.seated,
    headCenter: { x: 60, y: baseHeadY + headOffsetY },
    torsoRect: { x: 45, y: torsoY, w: 30, h: 15 },
    leftShoulder: { x: 46, y: shoulderY },
    rightShoulder: { x: 74, y: shoulderY },
    leftHand: handCoordsForArm("left", pose.leftArm, faceUp),
    rightHand: handCoordsForArm("right", pose.rightArm, faceUp),
    eyesClosed: pose.pose === "failed",
    idleGlance: pose.pose === "idle" && pose.animated,
  }
}

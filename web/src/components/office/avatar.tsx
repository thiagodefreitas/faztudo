import type { AvatarState } from "../agent-avatar"
import type { DeskState } from "./state"

// The office draws members with the shared AgentAvatar; this maps a desk
// state to the avatar's ring.
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

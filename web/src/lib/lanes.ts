import type { Lane, LaneWindow } from "../types"

// The chip shows one window: the measurement taken most recently.
export function primaryWindow(lane: Lane): LaneWindow | undefined {
  let best: LaneWindow | undefined
  let bestAt = -1
  for (const window of lane.windows) {
    const at = window.measured_at ? Date.parse(window.measured_at) : -1
    if (!best || at > bestAt) {
      best = window
      bestAt = Number.isNaN(at) ? -1 : at
    }
  }
  return best
}

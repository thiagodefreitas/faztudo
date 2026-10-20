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

function localDay(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

// runs_today counts the local day in runs_date. After midnight the server may
// still report yesterday's count, so a count from another day is hidden.
// A lane without runs_date comes from an older server and is shown as given.
export function runsTodayOf(lane: Lane, now: number): number | undefined {
  if (lane.runs_date && lane.runs_date !== localDay(now)) return undefined
  return lane.runs_today
}

import type { Lane, LaneHealth, LaneWindow } from "../types"
import { compactTokens, displayPct, formatCountdown } from "./lane-format"
import { HEALTH_META, summarizeLanes } from "./lane-health"
import { primaryWindow } from "./lanes"
import { formatAge } from "./time"

export interface LaneGauge {
  id: string
  health: LaneHealth
  // The main window: a percent when known, tokens otherwise, else "unknown".
  text: string
  // First line is the lane and its health; one line per window follows.
  tooltip: string[]
  // Search params for the Lanes page, so it can open at this lane.
  href: { lane: string }
}

// A window's figure: percent when known, tokens otherwise, never a made-up zero.
function amountOf(window: LaneWindow | undefined, health: LaneHealth): string {
  if (!window || health === "unknown") return "unknown"
  const pct = displayPct(window, health)
  if (pct !== undefined) return `${Math.round(pct)}%`
  if (window.tokens !== undefined && Number.isFinite(window.tokens)) return `${compactTokens(window.tokens)} tok`
  return "unknown"
}

export function laneGauge(lane: Lane, now: number): LaneGauge {
  const tooltip = [`${lane.id}: ${HEALTH_META[lane.health].label}`]
  if (lane.health_reason) tooltip.push(lane.health_reason)
  if (lane.windows.length === 0) tooltip.push("no usage reading")
  for (const window of lane.windows) {
    tooltip.push(
      `${window.name} ${amountOf(window, lane.health)}, ${formatCountdown(window.resets_at, now)}, ${window.source}, ${formatAge(window.measured_at, now)}`,
    )
  }
  return {
    id: lane.id,
    health: lane.health,
    text: amountOf(primaryWindow(lane), lane.health),
    tooltip,
    href: { lane: lane.id },
  }
}

// The single phone chip: worst health, and how many lanes sit at it.
export function lanesChip(lanes: Lane[]): { health: LaneHealth; label: string } {
  if (lanes.length === 0) return { health: "unknown", label: "Lanes" }
  const summary = summarizeLanes(lanes)
  return { health: summary.health, label: `Lanes ${summary.count}/${summary.total}` }
}

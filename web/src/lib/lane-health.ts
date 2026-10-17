import type { Lane, LaneHealth } from "../types"

// Health metadata for badges, the sidebar gauge and bar fill patterns.
// Shapes come from docs/design.md so state is never color alone.
export interface HealthMeta {
  label: string
  // Higher rank means worse health. "unknown" ranks below the states that
  // definitely block runs, so one unmeasured lane does not hide a lane
  // that needs conserving in the summary gauge.
  rank: number
  badgeClass: string
  gaugeClass: string
}

export const HEALTH_META: Record<LaneHealth, HealthMeta> = {
  available: { label: "Available", rank: 0, badgeClass: "bg-ok-soft text-ok", gaugeClass: "text-ok" },
  unknown: { label: "Unknown", rank: 1, badgeClass: "bg-sidebar text-muted", gaugeClass: "text-muted" },
  conserve: { label: "Conserve", rank: 2, badgeClass: "bg-warn-soft text-warn", gaugeClass: "text-warn" },
  unavailable: { label: "Unavailable", rank: 3, badgeClass: "bg-sidebar text-danger", gaugeClass: "text-danger" },
  exhausted: { label: "Exhausted", rank: 4, badgeClass: "bg-danger-soft text-danger", gaugeClass: "text-danger" },
}

export interface LaneSummary {
  health: LaneHealth
  // How many lanes sit at the worst health.
  count: number
  total: number
}

export function summarizeLanes(lanes: Lane[]): LaneSummary {
  if (lanes.length === 0) return { health: "unknown", count: 0, total: 0 }
  let worst: LaneHealth = "available"
  for (const lane of lanes) {
    if (HEALTH_META[lane.health].rank > HEALTH_META[worst].rank) worst = lane.health
  }
  const count = lanes.filter((lane) => lane.health === worst).length
  return { health: worst, count, total: lanes.length }
}

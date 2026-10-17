import type { LaneHealth, LaneWindow } from "../types"

// Unknown is never rendered as zero: an unmeasured figure says "unknown".
export function displayPct(window: LaneWindow, health: LaneHealth): number | undefined {
  if (health === "unknown") return undefined
  if (window.used_pct === undefined || !Number.isFinite(window.used_pct)) return undefined
  return window.used_pct
}

// Countdown to a window reset, for the bar caption under each window.
export function formatCountdown(resetsAt: string | undefined, now: number): string {
  if (!resetsAt) return "reset unknown"
  const at = Date.parse(resetsAt)
  if (Number.isNaN(at)) return "reset unknown"
  const ms = at - now
  if (ms < 45_000) return "reset soon"
  const min = Math.floor(ms / 60_000)
  const hours = Math.floor(min / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return `resets in ${days}d ${hours % 24}h`
  if (hours > 0) return `resets in ${hours}h ${min % 60}m`
  return `resets in ${min}m`
}

export function formatTokens(tokens: number | undefined): string {
  if (tokens === undefined || !Number.isFinite(tokens)) return "unknown"
  return Math.round(tokens).toLocaleString("en-US")
}

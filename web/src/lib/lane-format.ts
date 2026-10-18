import type { LaneHealth, LaneUsageReading, LaneWindow } from "../types"

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

// A token count the way people read it: 950, 12k, 1.2M.
export function compactTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 10_000) return `${Math.floor(tokens / 1000)}k`
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`
  return String(Math.round(tokens))
}

export function sparklinePath(readings: LaneUsageReading[], since: number, now: number): string {
  const points = readings.filter((r) => {
    const at = Date.parse(r.read_at)
    return Number.isFinite(at) && at >= since && at <= now && (r.window.used_pct !== undefined || r.window.tokens !== undefined)
  })
  if (points.length < 2) return ""
  const values = points.map((r) => r.window.used_pct ?? r.window.tokens ?? 0)
  const max = points.some((r) => r.window.used_pct !== undefined) ? 100 : Math.max(...values, 1)
  return points.map((r, i) => {
    const x = ((Date.parse(r.read_at) - since) / (now - since)) * 100
    const y = 24 - Math.min(24, Math.max(0, (values[i] / max) * 24))
    return `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`
  }).join(" ")
}

export function formatCostEstimate(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined
  return `about $${value.toFixed(value < 0.01 ? 4 : 2)} today, estimate`
}

export function formatAge(measuredAt: string | undefined, now: number): string {
  if (!measuredAt) return "age unknown"
  const then = Date.parse(measuredAt)
  if (Number.isNaN(then)) return "age unknown"
  const sec = Math.max(0, Math.floor((now - then) / 1000))
  if (sec < 45) return "just now"
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hours = Math.floor(min / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

export function formatElapsed(
  startedAt: string | undefined,
  endedAt: string | undefined,
  now: number,
): string {
  if (!startedAt) return "not started"
  const start = Date.parse(startedAt)
  if (Number.isNaN(start)) return "not started"
  const end = endedAt ? Date.parse(endedAt) : now
  if (Number.isNaN(end)) return "not started"
  const total = Math.max(0, Math.floor((end - start) / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds.toString().padStart(2, "0")}s`
  return `${seconds}s`
}

export function formatClock(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ""
  const hours = date.getHours().toString().padStart(2, "0")
  const minutes = date.getMinutes().toString().padStart(2, "0")
  return `${hours}:${minutes}`
}

export function iso(ms: number): string {
  return new Date(ms).toISOString()
}

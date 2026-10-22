const SHORTCUTS: Record<string, string> = {
  "@hourly": "Every hour",
  "@daily": "Every day at 00:00",
  "@midnight": "Every day at 00:00",
  "@weekly": "Every Sunday at 00:00",
  "@monthly": "On the 1st of every month at 00:00",
}

const NUMBER = /^\d+$/

// Plain words for the cron expressions people write most. Anything else comes
// back as written, so nothing is ever described wrongly.
export function describeSchedule(cron: string): string {
  const text = cron.trim()
  const shortcut = SHORTCUTS[text.toLowerCase()]
  if (shortcut) return shortcut
  const fields = text.split(/\s+/)
  if (fields.length !== 5) return text
  const [minute = "", hour = "", dayOfMonth = "", month = "", dayOfWeek = ""] = fields
  if (NUMBER.test(minute) && NUMBER.test(hour) && dayOfMonth === "*" && month === "*") {
    const at = `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`
    if (dayOfWeek === "*") return `Every day at ${at}`
    if (dayOfWeek === "1-5" || dayOfWeek.toLowerCase() === "mon-fri") return `Weekdays at ${at}`
  }
  if (/^\*\/\d+$/.test(minute) && hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    return `Every ${minute.slice(2)} minutes`
  }
  return text
}

/** The schedules the Repeat dialog offers; "custom" lets the Director type a cron expression. */
export const SCHEDULE_PRESETS = [
  { id: "weekday-morning", label: "Every weekday at 09:00", cron: "0 9 * * 1-5" },
  { id: "daily-evening", label: "Every day at 18:00", cron: "0 18 * * *" },
  { id: "monday-morning", label: "Every Monday at 09:00", cron: "0 9 * * 1" },
] as const

const BOUNDS = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12 },
  { min: 0, max: 6 },
] as const

// One cron field as the set of values it allows, or null when it is not valid.
// It takes numbers, ranges, lists, * and steps, as the daemon does.
function fieldValues(field: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>()
  for (const part of field.split(",")) {
    const [range = "", step, extra] = part.split("/")
    if (extra !== undefined || (step !== undefined && !/^[1-9]\d*$/.test(step))) return null
    let lo = min
    let hi = max
    if (range !== "*") {
      const [from = "", to, more] = range.split("-")
      if (more !== undefined || !/^\d+$/.test(from) || (to !== undefined && !/^\d+$/.test(to))) return null
      lo = Number(from)
      hi = to === undefined ? (step === undefined ? lo : max) : Number(to)
    }
    if (lo < min || hi > max || lo > hi) return null
    for (let value = lo; value <= hi; value += step === undefined ? 1 : Number(step)) out.add(value)
  }
  return out
}

/**
 * The first minute after `from`, in the browser's time zone, that a five-field
 * cron expression matches. Null when the expression is not valid or never
 * matches within four years. Like the daemon, a day matches when the day of
 * the month or the day of the week does if both are restricted.
 */
export function nextRun(cron: string, from: Date): Date | null {
  const fields = cron.trim().split(/\s+/)
  if (fields.length !== 5) return null
  const [minutes, hours, days, months, weekdays] = fields.map((field, i) => fieldValues(field, BOUNDS[i]?.min ?? 0, BOUNDS[i]?.max ?? 0))
  if (!minutes || !hours || !days || !months || !weekdays) return null
  const dayRestricted = fields[2] !== "*"
  const weekdayRestricted = fields[4] !== "*"
  const t = new Date(from)
  t.setSeconds(0, 0)
  t.setMinutes(t.getMinutes() + 1)
  const limit = from.getTime() + 4 * 366 * 24 * 60 * 60 * 1000
  while (t.getTime() <= limit) {
    const dayMatch = days.has(t.getDate())
    const weekdayMatch = weekdays.has(t.getDay())
    const dayOk = dayRestricted && weekdayRestricted ? dayMatch || weekdayMatch : dayMatch && weekdayMatch
    if (!months.has(t.getMonth() + 1) || !dayOk) {
      t.setDate(t.getDate() + 1)
      t.setHours(0, 0, 0, 0)
    } else if (!hours.has(t.getHours())) {
      t.setHours(t.getHours() + 1, 0, 0, 0)
    } else if (!minutes.has(t.getMinutes())) {
      t.setMinutes(t.getMinutes() + 1, 0, 0)
    } else {
      return t
    }
  }
  return null
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const DAY_MS = 24 * 60 * 60 * 1000

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/** The local calendar day of a timestamp, for telling where a day ends. */
export function dayKey(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ""
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
}

/** Today, Yesterday, a weekday within the last week, otherwise the date. */
export function dayLabel(iso: string, now: number): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ""
  const days = Math.round((startOfDay(new Date(now)) - startOfDay(date)) / DAY_MS)
  if (days === 0) return "Today"
  if (days === 1) return "Yesterday"
  if (days > 1 && days < 7) return WEEKDAYS[date.getDay()] ?? ""
  const year = date.getFullYear() === new Date(now).getFullYear() ? "" : ` ${date.getFullYear()}`
  return `${date.getDate()} ${MONTHS[date.getMonth()]}${year}`
}

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

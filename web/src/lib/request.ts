import { plainPreview } from "./inbox"

// The request without its leading @mention or /lane override, on one line.
export function runRequestOf(body: string | undefined): string | undefined {
  if (!body) return undefined
  const cleaned = plainPreview(body)
    .replace(/^(?:@\S+\s+|\/lane\s+\S+\/\S+\s+)+/i, "")
    .trim()
  return (cleaned || plainPreview(body)).replace(/\s+/g, " ").trim() || undefined
}

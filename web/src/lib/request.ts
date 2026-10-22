import { plainPreview } from "./inbox"

// The request without its leading @mention or /lane override, on one line.
export function runRequestOf(body: string | undefined): string | undefined {
  if (!body) return undefined
  const cleaned = plainPreview(body)
    .replace(/^(?:@\S+\s+|\/lane\s+\S+\/\S+\s+)+/i, "")
    .trim()
  return (cleaned || plainPreview(body)).replace(/\s+/g, " ").trim() || undefined
}

// The full request without its leading @mentions or /lane override, with its
// lines and markdown kept: what a routine made from the run should ask.
export function routinePromptOf(body: string | undefined): string {
  if (!body) return ""
  return body.replace(/^(?:\s*@\S+|\s*\/lane\s+\S+)+\s*/i, "").trim() || body.trim()
}

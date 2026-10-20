import type { Member, Message, Run } from "../types"

export type WorkColumn = "queued" | "running" | "needs_you" | "done" | "failed"

export const WORK_COLUMNS: WorkColumn[] = ["queued", "running", "needs_you", "done", "failed"]

export const WORK_TITLES: Record<WorkColumn, string> = {
  queued: "Queued",
  running: "Running",
  needs_you: "Needs you",
  done: "Done",
  failed: "Failed",
}

const DAY = 24 * 60 * 60 * 1000
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

export function workColumn(run: Run): WorkColumn {
  switch (run.state) {
    case "queued":
      return "queued"
    case "running":
    case "verifying":
      return "running"
    case "waiting_approval":
      return "needs_you"
    case "done":
      return "done"
    default:
      return "failed"
  }
}

// The time a ULID run id was made, or undefined when it is not one.
function ulidTime(id: string): number | undefined {
  if (id.length !== 26) return undefined
  let ms = 0
  for (const char of id.slice(0, 10)) {
    const value = ALPHABET.indexOf(char)
    if (value < 0) return undefined
    ms = ms * 32 + value
  }
  return ms
}

/** The newest moment known for a run: its end, its start, then its creation. */
export function runTime(run: Run): number | undefined {
  for (const stamp of [run.ended_at, run.started_at]) {
    const parsed = stamp ? Date.parse(stamp) : Number.NaN
    if (!Number.isNaN(parsed)) return parsed
  }
  return ulidTime(run.id)
}

export interface WorkCard {
  run: Run
  column: WorkColumn
  /** First line of the trigger message, empty when it is not loaded. */
  request: string
  /** Handle of the delegating agent when another agent wrote the trigger. */
  from?: string
}

export function firstLine(body: string): string {
  return body.split("\n").find((line) => line.trim() !== "")?.trim() ?? ""
}

const LEADING_ROUTING = /^\s*(?:@[\w-]+[\s,:]+|\/lane\s+\S+\s+)+/i

/** First line of a request after its leading mentions and /lane override. */
export function requestLine(body: string): string {
  return firstLine(body.replace(LEADING_ROUTING, "")) || firstLine(body)
}

/** Handle of the agent that wrote the trigger message, unless it is the run's own agent. */
export function fromHandle(run: Run, trigger: Message | undefined, members: Member[]): string | undefined {
  if (!trigger || trigger.author_id === run.agent_id) return undefined
  const author = members.find((member) => member.id === trigger.author_id)
  return author?.kind === "agent" ? author.handle : undefined
}

/** Runs of the last 24 hours grouped into columns, newest first. Unfinished runs stay whatever their age: an old queued run is the one to look at. */
export function groupWork(runs: Run[], messages: Message[], members: Member[], now: number): Record<WorkColumn, WorkCard[]> {
  const byId = new Map(messages.map((message) => [message.id, message]))
  const out: Record<WorkColumn, WorkCard[]> = { queued: [], running: [], needs_you: [], done: [], failed: [] }
  const recent = runs
    .map((run) => ({ run, time: runTime(run) }))
    .filter(({ run, time }) => time === undefined || now - time <= DAY || workColumn(run) !== "done" && workColumn(run) !== "failed")
    .sort((a, b) => (b.time ?? 0) - (a.time ?? 0))
  for (const { run } of recent) {
    const trigger = byId.get(run.trigger_message_id)
    const column = workColumn(run)
    // The request without its leading mention or /lane override, which
    // carry no information on a card that already names agent and lane.
    out[column].push({ run, column, request: trigger ? requestLine(trigger.body) : "", from: fromHandle(run, trigger, members) })
  }
  return out
}

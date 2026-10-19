import type { Handoff, Member, Message, Run, RunState } from "../types"

// A delegation is the set of handoff replies under one request. The server
// posts each handoff as a thread reply with a `handoff` field, and the run it
// starts names that reply as its trigger, so a piece is a reply plus the run
// that answers it. No separate handoff event is needed on the client.

/** A piece before its run exists is "pending". */
export type PieceState = RunState | "pending"

export interface Piece {
  message: Message
  handoff: Handoff
  /** The agent the work went to, by handle. */
  agent: Member | null
  /** The run that answers the piece: the latest one, retries included. */
  run: Run | null
  state: PieceState
  /** First line of the task, without the leading mention. */
  task: string
}

export interface PieceCounts {
  total: number
  /** queued, running or verifying */
  running: number
  /** waiting for an approval */
  waiting: number
  done: number
  failed: number
  cancelled: number
  /** no run yet */
  pending: number
}

/** The first line of a task, without the "@handle" the delegate tool put first. */
export function taskLine(body: string, max = 96): string {
  const line = body
    .replace(/^\s*@[\w-]+\s*/, "")
    .split("\n")
    .map((part) => part.replace(/^#+\s+/, "").replace(/\s+/g, " ").trim())
    .find((part) => part !== "") ?? ""
  return line.length > max ? `${line.slice(0, max - 3).trimEnd()}...` : line
}

/**
 * The run that answers a message: the one no later run retried. A retry
 * names the run it replaces in `retry_of`, so the replaced run steps aside.
 */
export function runForMessage(messageId: string, runs: Run[]): Run | null {
  const mine = runs.filter((run) => run.trigger_message_id === messageId)
  if (mine.length === 0) return null
  const replaced = new Set(mine.map((run) => run.retry_of).filter((id): id is string => typeof id === "string"))
  const current = mine.filter((run) => !replaced.has(run.id))
  return current.at(-1) ?? mine.at(-1) ?? null
}

/** The pieces handed out under a root message, in the order they were posted. */
export function delegationPieces(rootId: string, messages: Message[], runs: Run[], members: Member[]): Piece[] {
  const byHandle = new Map(members.map((member) => [member.handle.toLowerCase(), member]))
  return messages
    .filter((message): message is Message & { handoff: Handoff } => message.thread_id === rootId && message.handoff !== undefined)
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
    .map((message) => {
      const run = runForMessage(message.id, runs)
      return {
        message,
        handoff: message.handoff,
        agent: byHandle.get(message.handoff.to.toLowerCase()) ?? null,
        run,
        state: run?.state ?? "pending",
        task: taskLine(message.body),
      }
    })
}

export function countPieces(pieces: Piece[]): PieceCounts {
  const counts: PieceCounts = { total: pieces.length, running: 0, waiting: 0, done: 0, failed: 0, cancelled: 0, pending: 0 }
  for (const piece of pieces) {
    switch (piece.state) {
      case "queued":
      case "running":
      case "verifying":
        counts.running++
        break
      case "waiting_approval":
        counts.waiting++
        break
      case "done":
        counts.done++
        break
      case "failed":
        counts.failed++
        break
      case "cancelled":
        counts.cancelled++
        break
      case "pending":
        counts.pending++
        break
    }
  }
  return counts
}

/** "3 pieces: 1 running, 1 done, 1 failed", or null without pieces. */
export function delegationLine(counts: PieceCounts): string | null {
  if (counts.total === 0) return null
  const parts = [
    [counts.running, "running"],
    [counts.waiting, "waiting for you"],
    [counts.done, "done"],
    [counts.failed, "failed"],
    [counts.cancelled, "cancelled"],
    [counts.pending, "not started"],
  ] as const
  const detail = parts.filter(([count]) => count > 0).map(([count, label]) => `${count} ${label}`).join(", ")
  return `${counts.total} ${counts.total === 1 ? "piece" : "pieces"}: ${detail}`
}

/** The chip text of a piece. */
export function pieceLabel(state: PieceState): string {
  switch (state) {
    case "waiting_approval":
      return "waiting approval"
    case "pending":
      return "not started"
    default:
      return state
  }
}

/**
 * Root message id to summary line, for the roots of one channel. Only roots
 * with handoff replies in the list get a line.
 */
export function delegationLines(messages: Message[], runs: Run[], members: Member[]): Map<string, string> {
  const roots = new Set<string>()
  for (const message of messages) {
    if (message.thread_id && message.handoff) roots.add(message.thread_id)
  }
  const out = new Map<string, string>()
  for (const rootId of roots) {
    const line = delegationLine(countPieces(delegationPieces(rootId, messages, runs, members)))
    if (line) out.set(rootId, line)
  }
  return out
}

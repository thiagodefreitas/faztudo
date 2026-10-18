import { firstSentence } from "../../lib/answer-fold"
import type { Approval, Member, Message, Run } from "../../types"

export interface CatchUpLink {
  /** The message to scroll to, when one is loaded. */
  messageId?: string
  text: string
}

export interface CatchUp {
  total: number
  senders: { member: Member | undefined; name: string; count: number }[]
  merged: CatchUpLink[]
  failed: CatchUpLink[]
  waiting: CatchUpLink[]
  summary: string
}

function names(list: string[]): string {
  if (list.length <= 1) return list[0] ?? ""
  return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`
}

/**
 * What happened in a channel since the reader left, from messages, runs and
 * approvals that are already loaded. Nothing here calls an agent.
 */
export function buildCatchUp(input: {
  channelId: string
  /** The unread messages, replies included. */
  unread: Message[]
  all: Message[]
  members: Member[]
  runs: Run[]
  approvals: Approval[]
  summary?: string
}): CatchUp {
  const counts = new Map<string, number>()
  for (const message of input.unread) counts.set(message.author_id, (counts.get(message.author_id) ?? 0) + 1)
  const senders = [...counts]
    .map(([id, count]) => {
      const member = input.members.find((item) => item.id === id)
      return { member, name: member?.display_name ?? "Member", count }
    })
    .sort((a, b) => b.count - a.count)

  const since = input.unread.map((message) => message.created_at).sort()[0] ?? ""
  const messageFor = (runId: string | undefined, fallback?: string) =>
    input.all.find((message) => runId !== undefined && message.run_id === runId)?.id ??
    (fallback && input.all.some((message) => message.id === fallback) ? fallback : undefined)
  const agentName = (run: Run) => input.members.find((m) => m.id === run.agent_id)?.display_name ?? "An agent"
  const link = (run: Run, verb: string): CatchUpLink => {
    const messageId = messageFor(run.id, run.trigger_message_id)
    return { text: `${agentName(run)} ${verb}`, ...(messageId ? { messageId } : {}) }
  }

  const recent = input.runs.filter((run) => run.channel_id === input.channelId && !!run.ended_at && run.ended_at >= since)
  const mergedRuns = new Set(
    input.approvals.filter((a) => a.state === "resolved" && a.resolution?.option === "merge" && a.run_id).map((a) => a.run_id as string),
  )
  const merged = recent.filter((run) => mergedRuns.has(run.id)).map((run) => link(run, "merged a change"))
  const failed = recent.filter((run) => run.state === "failed").map((run) => link(run, "failed"))
  const waiting = input.approvals
    .filter((approval) => approval.channel_id === input.channelId && approval.state === "pending")
    .map((approval): CatchUpLink => {
      const messageId = messageFor(approval.run_id)
      return { text: approval.title, ...(messageId ? { messageId } : {}) }
    })

  return {
    total: input.unread.length,
    senders,
    merged,
    failed,
    waiting,
    summary: input.summary ? firstSentence(input.summary, 240) : "",
  }
}

/** The plain-words lines of the card, in order. */
export function catchUpSentences(data: CatchUp): string[] {
  const out: string[] = []
  if (data.total > 0) {
    out.push(`${data.total} new ${data.total === 1 ? "message" : "messages"} from ${names(data.senders.map((s) => s.name))}.`)
  }
  if (data.merged.length > 0) out.push(`${data.merged.length} ${data.merged.length === 1 ? "run" : "runs"} merged.`)
  if (data.failed.length > 0) out.push(`${data.failed.length} ${data.failed.length === 1 ? "run" : "runs"} failed.`)
  if (data.waiting.length > 0) out.push(`${data.waiting.length} waiting on you.`)
  return out
}

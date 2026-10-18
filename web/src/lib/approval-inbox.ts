import type { Approval, Channel, Member, Message, Project, Run } from "../types"
import { answeredChoice } from "./choices"
import { projectOfChannel } from "./projects"

export interface InboxFilter {
  project?: string
  agent?: string
}

export interface ApprovalRow {
  approval: Approval
  channel: Channel | undefined
  project: Project | undefined
  run: Run | undefined
  agent: Member | undefined
}

/** Pending approvals with the context the filters need, oldest first. */
export function approvalRows(
  approvals: Approval[],
  channels: Channel[],
  projects: Project[],
  runs: Run[],
  members: Member[],
): ApprovalRow[] {
  return approvals
    .filter((approval) => approval.state === "pending")
    .map((approval) => {
      const channel = channels.find((item) => item.id === approval.channel_id)
      const run = approval.run_id ? runs.find((item) => item.id === approval.run_id) : undefined
      const agent = members.find((item) => item.id === (run?.agent_id ?? approval.requested_by))
      return { approval, channel, project: channel ? projectOfChannel(channel, projects) : undefined, run, agent }
    })
    .sort((a, b) => a.approval.id.localeCompare(b.approval.id))
}

export function filterRows(rows: ApprovalRow[], filter: InboxFilter): ApprovalRow[] {
  return rows.filter(
    (row) => (!filter.project || row.project?.handle === filter.project) && (!filter.agent || row.agent?.id === filter.agent),
  )
}

export interface Question {
  message: Message
  channel: Channel | undefined
  project: Project | undefined
  agent: Member | undefined
}

/**
 * Messages from an agent that offered options and have no human answer yet.
 * `replies` holds the loaded thread of each message; one that is missing
 * counts as unanswered. ULIDs sort by time, so id order is age order.
 */
export function questionsWaiting(
  messages: Message[],
  replies: Map<string, Message[]>,
  channels: Channel[],
  projects: Project[],
  members: Member[],
): Question[] {
  const out: Question[] = []
  for (const message of messages) {
    if (message.thread_id || !message.options || message.options.length === 0) continue
    const agent = members.find((item) => item.id === message.author_id)
    if (agent?.kind !== "agent") continue
    if (answeredChoice(message.options, replies.get(message.id) ?? [], members) !== null) continue
    const channel = channels.find((item) => item.id === message.channel_id)
    out.push({ message, channel, project: channel ? projectOfChannel(channel, projects) : undefined, agent })
  }
  return out.sort((a, b) => a.message.id.localeCompare(b.message.id))
}

export function filterQuestions(questions: Question[], filter: InboxFilter): Question[] {
  return questions.filter(
    (q) => (!filter.project || q.project?.handle === filter.project) && (!filter.agent || q.agent?.id === filter.agent),
  )
}

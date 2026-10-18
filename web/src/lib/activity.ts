import type { Approval, Lane, Member, Message, Run, RunState } from "../types"
import { firstSentence } from "./answer-fold"
import { gistOf } from "./run-sentence"

const LIVE = new Set<RunState>(["queued", "running", "verifying"])

export interface WorkingRun {
  run: Run
  agent: Member | null
  /** First words of the message that started the run. */
  gist: string
}

export interface Activity {
  working: WorkingRun[]
  /** Approvals in this channel that wait for a human. */
  waiting: Approval[]
  /** Lanes of this channel's agents that cannot run now. */
  trouble: Lane[]
}

/** Who works on what in a channel right now, for the strip above the transcript. */
export function channelActivity(input: {
  channelId: string
  agentIds: string[]
  runs: Run[]
  approvals: Approval[]
  lanes: Lane[]
  members: Member[]
  messages: Message[]
}): Activity {
  const working = input.runs
    .filter((run) => run.channel_id === input.channelId && LIVE.has(run.state))
    .map((run) => ({
      run,
      agent: input.members.find((member) => member.id === run.agent_id) ?? null,
      gist: gistOf(input.messages.find((message) => message.id === run.trigger_message_id)?.body),
    }))
  const waiting = input.approvals.filter((approval) => approval.channel_id === input.channelId && approval.state === "pending")
  const laneIds = new Set(
    input.members.filter((member) => input.agentIds.includes(member.id)).flatMap((member) => member.agent?.lanes ?? []),
  )
  const trouble = input.lanes.filter((lane) => laneIds.has(lane.id) && (lane.health === "exhausted" || lane.health === "unavailable"))
  return { working, waiting, trouble }
}

export function isQuiet(activity: Activity): boolean {
  return activity.working.length === 0 && activity.waiting.length === 0 && activity.trouble.length === 0
}

/**
 * One line for a channel that was opened with unread messages, built from the
 * stored channel summary when there is one. Nothing is generated here.
 */
export function catchUpLine(input: { unread: number; summary?: string; waiting: number }): string | null {
  if (input.unread <= 0) return null
  const parts = [`${input.unread} new ${input.unread === 1 ? "message" : "messages"}.`]
  const gist = input.summary ? firstSentence(input.summary, 200) : ""
  if (gist) parts.push(`Earlier: ${gist}`)
  if (input.waiting > 0) parts.push(`${input.waiting} waiting for you.`)
  return parts.join(" ")
}

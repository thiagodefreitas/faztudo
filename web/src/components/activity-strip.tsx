import { useState } from "react"
import { catchUpLine, channelActivity, isQuiet } from "../lib/activity"
import { cx } from "../lib/cx"
import { formatElapsed } from "../lib/time"
import { useNow } from "../state/now"
import { useApprovals, useChannelSummary, useLanes, useMembers, useMessages, useRuns } from "../state/queries"
import type { Channel } from "../types"
import { AgentAvatar } from "./agent-avatar"
import { healthDotClass } from "./lane-chip"

// The top of a channel: what is going on right now, and, when the channel was
// opened with unread messages, one line of catch-up from the stored summary.
// Key it by channel so the unread count is read once per visit.
export function ActivityStrip({ channel, onOpenRun }: { channel: Channel; onOpenRun: (runId: string) => void }) {
  const now = useNow()
  const runs = useRuns()
  const approvals = useApprovals()
  const lanes = useLanes()
  const members = useMembers()
  const messages = useMessages(channel.id)
  const [unreadAtOpen] = useState(channel.unread)
  const [dismissed, setDismissed] = useState(false)
  const summary = useChannelSummary(channel.id, unreadAtOpen > 0)

  const activity = channelActivity({
    channelId: channel.id,
    agentIds: channel.member_ids,
    runs: runs.data ?? [],
    approvals: approvals.data ?? [],
    lanes: lanes.data ?? [],
    members: members.data ?? [],
    messages: messages.data ?? [],
  })
  const catchUp = dismissed
    ? null
    : catchUpLine({ unread: unreadAtOpen, ...(summary.data?.text ? { summary: summary.data.text } : {}), waiting: activity.waiting.length })
  if (!catchUp && isQuiet(activity)) return null

  const firstWaiting = activity.waiting.find((approval) => approval.run_id)
  return (
    <section aria-label="Channel activity" className="flex flex-col gap-1 border-b border-line px-3 py-1.5 text-[12px] md:px-4">
      {catchUp && (
        <p className="flex items-start gap-2 text-ink">
          <span className="min-w-0 flex-1">
            <span className="font-medium">Since you were away: </span>
            {catchUp}
          </span>
          <button type="button" onClick={() => setDismissed(true)} className="min-h-8 shrink-0 rounded px-1 text-muted hover:text-ink md:min-h-6">
            Dismiss
          </button>
        </p>
      )}
      {!isQuiet(activity) && (
        <ul className="flex flex-wrap items-center gap-x-4 gap-y-1">
          {activity.working.map(({ run, agent, gist }) => (
            <li key={run.id}>
              <button
                type="button"
                onClick={() => onOpenRun(run.id)}
                className="inline-flex min-h-8 max-w-full items-center gap-1.5 rounded text-left hover:text-ink md:min-h-6"
              >
                <AgentAvatar member={agent} size={16} state="working" decorative />
                <span className="font-medium">{agent?.display_name ?? "Agent"}</span>
                {gist && <span className="min-w-0 truncate text-muted">{gist}</span>}
                <span className="font-mono tabular-nums text-faint">{formatElapsed(run.started_at, undefined, now)}</span>
              </button>
            </li>
          ))}
          {activity.waiting.length > 0 && (
            <li>
              <button
                type="button"
                disabled={!firstWaiting?.run_id}
                onClick={() => firstWaiting?.run_id && onOpenRun(firstWaiting.run_id)}
                className="inline-flex min-h-8 items-center rounded font-medium text-warn md:min-h-6"
              >
                {activity.waiting.length} {activity.waiting.length === 1 ? "approval" : "approvals"} waiting for you
              </button>
            </li>
          )}
          {activity.trouble.map((lane) => (
            <li key={lane.id} className="inline-flex items-center gap-1.5 text-muted">
              <span className={cx("h-2 w-2 rounded-full", healthDotClass(lane.health))} aria-hidden="true" />
              <span className="font-mono">{lane.id}</span> {lane.health}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

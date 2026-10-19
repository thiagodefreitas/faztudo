import { useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { api } from "../api/client"
import { catchUpLine, channelActivity, isQuiet } from "../lib/activity"
import { cx } from "../lib/cx"
import { formatElapsed } from "../lib/time"
import { qk } from "../state/keys"
import { replaceById } from "../state/merge"
import { useNow } from "../state/now"
import { useApprovals, useChannelSummary, useLanes, useMembers, useMessages, useRuns } from "../state/queries"
import type { Channel, Run } from "../types"
import { AgentAvatar } from "./agent-avatar"
import { healthDotClass } from "./lane-chip"

// The top of a channel: who is working now (avatar, handle, what, elapsed,
// Stop), approvals waiting, lanes in trouble, and, when the channel was
// opened with unread messages, one line of catch-up from the stored summary.
// Key it by channel so the unread count is read once per visit. A page that
// shows its own catch-up card passes catchUp={false}. The per-second clock
// lives in the Elapsed leaf, so a tick re-renders that text and nothing else.
export function ActivityStrip({
  channel,
  onOpenRun,
  catchUp: showCatchUp = true,
}: {
  channel: Channel
  onOpenRun: (runId: string) => void
  catchUp?: boolean
}) {
  const runs = useRuns()
  const approvals = useApprovals()
  const lanes = useLanes()
  const members = useMembers()
  const messages = useMessages(channel.id)
  const [unreadAtOpen] = useState(channel.unread)
  const [dismissed, setDismissed] = useState(false)
  const summary = useChannelSummary(channel.id, showCatchUp && unreadAtOpen > 0)

  const activity = channelActivity({
    channelId: channel.id,
    agentIds: channel.member_ids,
    runs: runs.data ?? [],
    approvals: approvals.data ?? [],
    lanes: lanes.data ?? [],
    members: members.data ?? [],
    messages: messages.data ?? [],
  })
  const catchUp = dismissed || !showCatchUp
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
            <li key={run.id} className="inline-flex max-w-full items-center gap-1">
              <button
                type="button"
                onClick={() => onOpenRun(run.id)}
                title={gist ? `Open the run: ${gist}` : "Open the run"}
                className="inline-flex min-h-8 min-w-0 max-w-full items-center gap-1.5 rounded text-left hover:text-ink md:min-h-6"
              >
                <AgentAvatar member={agent} size={16} state="working" decorative />
                <span className="font-medium">{agent?.display_name ?? "Agent"}</span>
                {agent && <span className="text-faint max-sm:hidden">@{agent.handle}</span>}
                {gist && <span className="min-w-0 truncate text-muted">{gist}</span>}
                <Elapsed run={run} />
              </button>
              <StopButton run={run} handle={agent?.handle ?? "agent"} />
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

// Only this leaf subscribes to the clock.
function Elapsed({ run }: { run: Run }) {
  const now = useNow()
  return <span className="font-mono tabular-nums text-faint">{formatElapsed(run.started_at, undefined, now)}</span>
}

// The same cancel the run card offers; the strip only lists the states the
// card lets you cancel (queued, running, verifying).
function StopButton({ run, handle }: { run: Run; handle: string }) {
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  async function stop() {
    setBusy(true)
    try {
      const next = await api.cancelRun(run.id)
      qc.setQueryData<Run[]>(qk.runs, (list = []) => replaceById(list, next))
    } catch {
      // The run card reports failures; the strip only updates once the cancel lands.
    } finally {
      setBusy(false)
    }
  }
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => void stop()}
      aria-label={`Stop the run of @${handle}`}
      title="Stop this run"
      className="min-h-8 rounded-full border border-line px-1.5 text-[11px] font-medium text-muted hover:border-danger hover:bg-danger-soft hover:text-danger disabled:opacity-60 md:min-h-6"
    >
      Stop
    </button>
  )
}

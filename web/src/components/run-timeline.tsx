import { cx } from "../lib/cx"
import { runTimeline, switchedWhy, type StepTone } from "../lib/run-timeline"
import { formatClock } from "../lib/time"
import { useNow } from "../state/now"
import { approvalForRun, useApprovals, useLanes, useMessages, useNotices, useRuns } from "../state/queries"
import type { Run } from "../types"

const DOT: Record<StepTone, string> = {
  info: "bg-faint",
  ok: "bg-ok",
  warn: "bg-warn",
  danger: "bg-danger",
}

// The story of one run, on demand: which lane and why, what it touched, how it
// was checked, how long it took. Links lead to the diff and the raw log.
export function RunTimeline({
  run,
  channelId,
  onShowDiff,
  onShowLog,
}: {
  run: Run
  channelId: string
  onShowDiff: () => void
  onShowLog: () => void
}) {
  const now = useNow()
  const runs = useRuns()
  const lanes = useLanes()
  const approvals = useApprovals()
  const notices = useNotices()
  const messages = useMessages(channelId)
  const previous = run.retry_of ? runs.data?.find((item) => item.id === run.retry_of) : undefined
  const why = switchedWhy(notices.data.find((notice) => notice.run_id === run.id)?.text)
  const steps = runTimeline({
    run,
    now,
    trigger: messages.data?.find((message) => message.id === run.trigger_message_id),
    previous,
    why,
    lane: lanes.data?.find((lane) => lane.id === run.lane_id),
    approval: approvalForRun(approvals.data, run.id),
  })

  return (
    <div className="px-3 py-2">
      <ol className="flex flex-col gap-3" aria-label="Run timeline">
        {steps.map((step) => (
          <li key={step.key} className="flex gap-2">
            <span className={cx("mt-1.5 h-2 w-2 shrink-0 rounded-full", DOT[step.tone])} aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="flex items-baseline gap-2 text-[13px] font-medium">
                <span className="min-w-0 flex-1">{step.title}</span>
                {step.at && (
                  <time className="shrink-0 font-mono text-[11px] font-normal text-faint" dateTime={step.at}>
                    {formatClock(step.at)}
                  </time>
                )}
              </p>
              {step.detail && <p className="whitespace-pre-wrap break-words text-[12px] text-muted">{step.detail}</p>}
            </div>
          </li>
        ))}
      </ol>
      <p className="mt-4 flex gap-3 text-[12px]">
        {run.diff_stat && (
          <button type="button" onClick={onShowDiff} className="min-h-8 font-medium text-accent hover:underline">
            View diff
          </button>
        )}
        <button type="button" onClick={onShowLog} className="min-h-8 font-medium text-accent hover:underline">
          Raw log
        </button>
      </p>
    </div>
  )
}

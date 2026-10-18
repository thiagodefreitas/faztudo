import * as DropdownMenu from "@radix-ui/react-dropdown-menu"
import { useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { api } from "../api/client"
import { hueFor } from "../lib/avatar"
import { cx } from "../lib/cx"
import { runSentence } from "../lib/run-sentence"
import { switchedWhy, tokensDetail, tokensTitle } from "../lib/run-timeline"
import { formatElapsed } from "../lib/time"
import { qk } from "../state/keys"
import { replaceById } from "../state/merge"
import { useNow } from "../state/now"
import { approvalForRun, useApprovals, useLanes, useMembers, useNotices, useOutput, useRunDiff, useRuns } from "../state/queries"
import type { Approval, Lane, Member, OutputLine, Run, RunState } from "../types"
import { ApprovalCard } from "./approval-card"
import { AgentAvatar, type AvatarState } from "./agent-avatar"
import { LaneChip } from "./lane-chip"

const RING: Partial<Record<RunState, AvatarState>> = {
  running: "working",
  verifying: "working",
  waiting_approval: "waiting",
  failed: "failed",
}

const EDGE: Record<RunState, string> = {
  queued: "bg-line",
  running: "bg-accent",
  waiting_approval: "bg-warn",
  verifying: "bg-accent",
  done: "bg-ok",
  failed: "bg-danger",
  cancelled: "bg-line",
}

const LIVE = new Set<RunState>(["queued", "running", "waiting_approval", "verifying"])
const WORKING = new Set<RunState>(["queued", "running", "verifying"])

const BUTTON = "min-h-10 rounded-md border border-line px-3 text-[12px] hover:bg-canvas md:min-h-8 md:px-2"
const PRIMARY = "min-h-10 rounded-md border border-accent bg-accent px-3 text-[12px] font-medium text-canvas hover:opacity-90 md:min-h-8 md:px-2"

export function RunCard({ run, channelId }: { run: Run; channelId: string }) {
  const now = useNow()
  const members = useMembers()
  const lanes = useLanes()
  const approvals = useApprovals()
  const output = useOutput(run.id)
  const runs = useRuns()
  const notices = useNotices()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const agent = members.data?.find((member) => member.id === run.agent_id) ?? null
  const lane = lanes.data?.find((item) => item.id === run.lane_id)
  const approval = approvalForRun(approvals.data, run.id)
  const approvalDiff = useRunDiff(run.id, approval?.state === "pending" && approval.commit_message !== undefined)
  const decider = approval?.resolution ? members.data?.find((member) => member.id === approval.resolution?.by)?.display_name : undefined
  const retryLanes = agent?.agent?.lanes ?? [run.lane_id]
  const previous = run.retry_of ? runs.data?.find((item) => item.id === run.retry_of) : undefined
  const why =
    switchedWhy(notices.data.find((notice) => notice.run_id === run.id)?.text) ??
    (previous ? `retry after ${previous.lane_id} failed` : undefined)

  return (
    <RunCardView
      run={run}
      agent={agent}
      lane={lane}
      lines={output.data ?? []}
      approval={approval}
      approvalDiff={approvalDiff.data?.diff}
      decider={decider}
      now={now}
      retryLanes={retryLanes}
      {...(why ? { why } : {})}
      onTimeline={() => {
        void navigate({
          to: "/c/$channelId",
          params: { channelId },
          search: { run: run.id, view: "timeline" },
        })
      }}
      onViewDiff={() => {
        void navigate({
          to: "/c/$channelId",
          params: { channelId },
          search: { run: run.id, view: "diff" },
        })
      }}
      onCancel={() => {
        void api.cancelRun(run.id).then((next) => {
          qc.setQueryData<Run[]>(qk.runs, (list = []) => replaceById(list, next))
        })
      }}
      onRetry={(laneId) => {
        void api.retryRun(run.id, { lane_id: laneId }).then((next) => {
          qc.setQueryData<Run[]>(qk.runs, (list = []) => replaceById(list, next))
        })
      }}
      onResolve={(option, commitMessage) => {
        if (!approval) return
        const body = commitMessage ? { option, commit_message: commitMessage } : { option }
        void api.resolveApproval(approval.id, body).then((next) => {
          qc.setQueryData<Approval[]>(qk.approvals, (list = []) => replaceById(list, next))
        })
      }}
    />
  )
}

// A run card says what happened in one sentence, keeps lane, mode, time and
// the reason for the lane on one quiet line, offers the one action that fits
// the state, and folds verification, output and the timeline under Details.
export function RunCardView({
  run,
  agent,
  lane,
  lines,
  approval,
  approvalDiff,
  decider,
  now,
  retryLanes,
  why,
  onTimeline,
  onViewDiff,
  onCancel,
  onRetry,
  onResolve,
}: {
  run: Run
  agent: Member | null
  lane: Lane | undefined
  lines: OutputLine[]
  approval: Approval | null
  /** The diff behind a pending write approval, once loaded. */
  approvalDiff?: string | undefined
  /** Who decided the approval, once it is decided. */
  decider?: string | undefined
  now: number
  retryLanes?: string[]
  /** Why this lane, for example "codex/default skipped: busy". */
  why?: string
  onTimeline?: () => void
  onViewDiff: () => void
  onCancel: () => void
  onRetry: (laneId: string) => void
  onResolve: (option: string, commitMessage?: string) => void
}) {
  const live = LIVE.has(run.state)
  const working = WORKING.has(run.state)
  const name = agent?.display_name ?? "Agent"
  const ended = live ? undefined : run.ended_at
  const lanes = retryLanes ?? agent?.agent?.lanes ?? []
  const retryable = run.state === "failed" || run.state === "cancelled"
  const peek = live ? lines.slice(-3) : []
  const failedChecks = run.verification && !run.verification.ok ? run.verification : null
  const tail = lines.slice(-12)
  const detail = [run.mode, formatElapsed(run.started_at, ended, now), why].filter(Boolean).join(" | ")

  return (
    <article
      aria-label={`${name} run on ${run.lane_id}`}
      data-state={run.state}
      className="fz-rise mt-2 flex max-w-2xl overflow-hidden rounded-lg border border-line bg-surface"
    >
      <div className={cx("w-1 shrink-0", hueFor(agent).edge)} aria-hidden="true" />
      <div className="min-w-0 flex-1 p-3">
        <div className="flex items-start gap-2">
          <AgentAvatar member={agent} size={20} state={RING[run.state]} decorative className="mt-px shrink-0" />
          <p data-testid="run-sentence" className="min-w-0 flex-1 text-[14px] font-medium leading-5">
            {runSentence(run, name, approval)}
          </p>
          <span className={cx("mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full", EDGE[run.state], working && "motion-safe:animate-pulse")} aria-hidden="true" />
        </div>
        <p className="mt-0.5 pl-7 text-[12px] text-muted">
          <span className="font-mono">{run.lane_id}</span> | {detail}
        </p>
        {peek.length > 0 && (
          <pre className="mt-2 ml-7 max-h-16 overflow-hidden rounded-md bg-code px-2 py-1.5 font-mono text-[12px] leading-5">
            {peek.map((line) => (
              <span key={line.seq} className={line.stream === "stderr" ? "text-danger" : undefined}>
                {line.text}
              </span>
            ))}
          </pre>
        )}
        {failedChecks && (
          <div className="mt-2 ml-7 rounded-md border-l-2 border-danger bg-danger-soft px-2.5 py-2">
            <p className="text-[13px] font-medium">Failed</p>
            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[12px] leading-5">{failedChecks.detail}</pre>
          </div>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-2 pl-7">
          {run.diff_stat && (
            <button type="button" onClick={onViewDiff} className={run.state === "done" ? PRIMARY : BUTTON}>
              View diff ({run.diff_stat.files} {run.diff_stat.files === 1 ? "file" : "files"},{" "}
              <span className={run.state === "done" ? undefined : "text-ok"}>+{run.diff_stat.insertions}</span>{" "}
              <span className={run.state === "done" ? undefined : "text-danger"}>-{run.diff_stat.deletions}</span>)
            </button>
          )}
          {working && (
            <button type="button" onClick={onCancel} className={BUTTON}>
              Cancel
            </button>
          )}
          {retryable && lanes.length > 0 && (
            <DropdownMenu.Root>
              <DropdownMenu.Trigger className={run.state === "failed" ? PRIMARY : BUTTON}>Retry</DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  sideOffset={6}
                  className="z-50 min-w-44 rounded-md border border-line bg-surface p-1 shadow-lg"
                >
                  {lanes.map((laneId) => (
                    <DropdownMenu.Item
                      key={laneId}
                      onSelect={() => onRetry(laneId)}
                      className="cursor-pointer rounded px-2 py-1.5 text-[13px] outline-none data-[highlighted]:bg-accent-soft"
                    >
                      Retry on {laneId}
                    </DropdownMenu.Item>
                  ))}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          )}
        </div>
        {approval && (
          <ApprovalCard approval={approval} onResolve={onResolve} run={run} agentName={name} diff={approvalDiff} decider={decider} />
        )}
        <details className="mt-2 pl-7">
          <summary className="inline-flex min-h-8 cursor-pointer items-center text-[12px] text-muted hover:text-ink">Details</summary>
          <div className="mt-1 flex flex-col gap-2">
            <LaneChip lane={lane} now={now} />
            <p className="text-[12px] text-muted">
              {tokensTitle(run)}
              {run.tokens ? `. ${tokensDetail(run)}` : ""}
            </p>
            {run.verification?.ok && (
              <div className="rounded-md border-l-2 border-ok bg-ok-soft px-2.5 py-2">
                <p className="text-[13px] font-medium">Passed</p>
                <pre className="mt-1 whitespace-pre-wrap font-mono text-[12px] leading-5">{run.verification.detail}</pre>
              </div>
            )}
            {run.failure_reason && !run.verification && <p className="text-[13px] text-danger">{run.failure_reason}</p>}
            <pre className="max-h-40 overflow-auto rounded-md bg-code px-2 py-1.5 font-mono text-[12px] leading-5">
              {tail.length === 0 ? (
                <span className="text-faint">No output yet.</span>
              ) : (
                tail.map((line) => (
                  <span key={line.seq} className={line.stream === "stderr" ? "text-danger" : undefined}>
                    {line.text}
                  </span>
                ))
              )}
            </pre>
            {onTimeline && (
              <button type="button" onClick={onTimeline} className={cx(BUTTON, "self-start")}>
                Open timeline
              </button>
            )}
          </div>
        </details>
      </div>
    </article>
  )
}

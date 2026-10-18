import * as DropdownMenu from "@radix-ui/react-dropdown-menu"
import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { api } from "../api/client"
import { hueFor } from "../lib/avatar"
import { cx } from "../lib/cx"
import { formatElapsed } from "../lib/time"
import { qk } from "../state/keys"
import { replaceById } from "../state/merge"
import { useNow } from "../state/now"
import { approvalForRun, useApprovals, useLanes, useMembers, useOutput } from "../state/queries"
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

const STATE_LABEL: Record<RunState, string> = {
  queued: "Queued",
  running: "Running",
  waiting_approval: "Needs approval",
  verifying: "Verifying",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
}

const STATE_CLASS: Record<RunState, string> = {
  queued: "bg-sidebar text-muted",
  running: "bg-accent-soft text-accent",
  waiting_approval: "bg-warn-soft text-warn",
  verifying: "bg-accent-soft text-accent",
  done: "bg-ok-soft text-ok",
  failed: "bg-danger-soft text-danger",
  cancelled: "bg-sidebar text-muted",
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

export function RunCard({ run, channelId }: { run: Run; channelId: string }) {
  const now = useNow()
  const members = useMembers()
  const lanes = useLanes()
  const approvals = useApprovals()
  const output = useOutput(run.id)
  const qc = useQueryClient()
  const navigate = useNavigate()
  const agent = members.data?.find((member) => member.id === run.agent_id) ?? null
  const lane = lanes.data?.find((item) => item.id === run.lane_id)
  const approval = approvalForRun(approvals.data, run.id)
  const retryLanes = agent?.agent?.lanes ?? [run.lane_id]

  return (
    <RunCardView
      run={run}
      agent={agent}
      lane={lane}
      lines={output.data ?? []}
      approval={approval}
      now={now}
      retryLanes={retryLanes}
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

export function RunCardView({
  run,
  agent,
  lane,
  lines,
  approval,
  now,
  retryLanes,
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
  now: number
  retryLanes?: string[]
  onViewDiff: () => void
  onCancel: () => void
  onRetry: (laneId: string) => void
  onResolve: (option: string, commitMessage?: string) => void
}) {
  const live = LIVE.has(run.state)
  const [outputOpen, setOutputOpen] = useState(live)
  const tail = lines.slice(-12)
  const ended = live ? undefined : run.ended_at
  const lanes = retryLanes ?? agent?.agent?.lanes ?? []
  const retryable = run.state === "failed" || run.state === "cancelled"

  return (
    <article
      aria-label={`${agent?.display_name ?? "Agent"} run on ${run.lane_id}`}
      data-state={run.state}
      className="fz-rise mt-2 flex max-w-2xl overflow-hidden rounded-lg border border-line bg-surface"
    >
      <div className={cx("w-1 shrink-0", hueFor(agent).edge)} aria-hidden="true" />
      <div className="min-w-0 flex-1 p-3">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <AgentAvatar member={agent} size={20} state={RING[run.state]} decorative />
          <p className="text-[13px] font-semibold">{agent?.display_name ?? "Agent"}</p>
          <p className="font-mono text-[12px] text-muted">{run.lane_id}</p>
          <p className="text-[12px] text-faint">{run.mode}</p>
          <span
            className={cx(
              "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium",
              STATE_CLASS[run.state],
            )}
          >
            <span className={cx("h-1.5 w-1.5 rounded-full", EDGE[run.state], live && "motion-safe:animate-pulse")} aria-hidden="true" />
            {STATE_LABEL[run.state]}
          </span>
          <p className="ml-auto font-mono text-[12px] tabular-nums text-muted">{formatElapsed(run.started_at, ended, now)}</p>
        </div>
        <div className="mt-2">
          <LaneChip lane={lane} now={now} />
        </div>
        {run.verification && (
          <div
            className={cx(
              "mt-3 rounded-md border-l-2 px-2.5 py-2",
              run.verification.ok ? "border-ok bg-ok-soft" : "border-danger bg-danger-soft",
            )}
          >
            <p className="text-[13px] font-medium">{run.verification.ok ? "Passed" : "Failed"}</p>
            <pre className="mt-1 whitespace-pre-wrap font-mono text-[12px] leading-5">{run.verification.detail}</pre>
          </div>
        )}
        {run.failure_reason && !run.verification && <p className="mt-2 text-[13px] text-danger">{run.failure_reason}</p>}
        <details
          className="mt-3"
          open={outputOpen}
          onToggle={(event) => setOutputOpen((event.currentTarget as HTMLDetailsElement).open)}
        >
          <summary className="cursor-pointer text-[12px] text-muted">Output</summary>
          <pre className="mt-1 max-h-40 overflow-auto rounded-md bg-code px-2 py-1.5 font-mono text-[12px] leading-5">
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
        </details>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {run.diff_stat && (
            <button type="button" onClick={onViewDiff} className="min-h-10 rounded-md border border-line px-3 text-[12px] hover:bg-canvas md:min-h-8 md:px-2">
              {run.diff_stat.files} {run.diff_stat.files === 1 ? "file" : "files"}{" "}
              <span className="text-ok">+{run.diff_stat.insertions}</span>{" "}
              <span className="text-danger">-{run.diff_stat.deletions}</span> View diff
            </button>
          )}
          {live && (
            <button type="button" onClick={onCancel} className="min-h-10 rounded-md border border-line px-3 text-[12px] hover:bg-canvas md:min-h-8 md:px-2">
              Cancel
            </button>
          )}
          {retryable && lanes.length > 0 && (
            <DropdownMenu.Root>
              <DropdownMenu.Trigger className="min-h-10 rounded-md border border-line px-3 text-[12px] hover:bg-canvas md:min-h-8 md:px-2">Retry</DropdownMenu.Trigger>
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
        {approval && <ApprovalCard approval={approval} onResolve={onResolve} />}
      </div>
    </article>
  )
}

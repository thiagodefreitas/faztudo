import { Link } from "@tanstack/react-router"
import { channelsOfProject } from "../../lib/projects"
import type { Approval, Channel, Project, Run, Task } from "../../types"

export type DigestPeriod = "today" | "week"
export type DigestKind = "merged" | "failed" | "waiting" | "tasks" | "usage"

export interface DigestItems {
  merged: Run[]
  failed: Run[]
  waiting: Approval[]
  tasks: Task[]
  usage: Run[]
  tokens?: number
  cost?: number
}

export function digestItems(project: Project, channels: Channel[], runs: Run[], approvals: Approval[], tasks: Task[], period: DigestPeriod, now: Date): DigestItems {
  const ids = new Set(channelsOfProject(project, channels).map((channel) => channel.id))
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  if (period === "week") start.setDate(start.getDate() - 6)
  const inPeriod = (at?: string) => {
    if (!at) return false
    const date = new Date(at).getTime()
    return Number.isFinite(date) && date >= start.getTime() && date <= now.getTime()
  }
  const finished = runs.filter((run) => ids.has(run.channel_id) && inPeriod(run.ended_at))
  const usage = finished.filter((run) => run.tokens || run.cost_usd !== undefined)
  const tokenRuns = usage.filter((run) => run.tokens)
  const pricedRuns = usage.filter((run) => run.cost_usd !== undefined)
  return {
    merged: finished.filter((run) => run.state === "done" && run.mode === "write" && (run.diff_stat?.files ?? 0) > 0),
    failed: finished.filter((run) => run.state === "failed"),
    // Approvals have no request timestamp in the API. This is the current queue.
    waiting: approvals.filter((approval) => ids.has(approval.channel_id) && approval.state === "pending"),
    tasks: tasks.filter((task) => ids.has(task.channel_id) && task.status === "done" && inPeriod(task.updated_at)),
    usage,
    tokens: tokenRuns.length ? tokenRuns.reduce((sum, run) => sum + (run.tokens?.input ?? 0) + (run.tokens?.output ?? 0) + (run.tokens?.cache_read ?? 0) + (run.tokens?.cache_write ?? 0), 0) : undefined,
    cost: pricedRuns.length ? pricedRuns.reduce((sum, run) => sum + (run.cost_usd ?? 0), 0) : undefined,
  }
}

export function ProjectDigest({ project, channels, runs, approvals, tasks, now }: { project: Project; channels: Channel[]; runs: Run[]; approvals: Approval[]; tasks: Task[]; now: Date }) {
  return <section aria-label="Project digest" className="rounded-lg border border-line bg-surface p-3">
    <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-faint">Digest</h2>
    {(["today", "week"] as const).map((period) => {
      const items = digestItems(project, channels, runs, approvals, tasks, period, now)
      const href = (kind: DigestKind) => ({ to: "/projects/$handle/activity" as const, params: { handle: project.handle }, search: { period, kind } })
      return <div key={period} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line py-2 text-[12px] first:border-0 first:pt-0 last:pb-0">
        <strong className="w-24 shrink-0 text-ink">{period === "today" ? "Today" : "Last 7 days"}</strong>
        <Link {...href("merged")} className="text-accent hover:underline">merged {items.merged.length}</Link>
        <Link {...href("failed")} className="text-accent hover:underline">failed {items.failed.length}</Link>
        <Link {...href("waiting")} className="text-accent hover:underline">waiting on you {items.waiting.length}</Link>
        <Link {...href("tasks")} className="text-accent hover:underline">tasks done {items.tasks.length}</Link>
        {items.tokens !== undefined && (
          <Link {...href("usage")} className="text-accent hover:underline">
            {items.tokens.toLocaleString()} tokens{items.cost === undefined ? "" : `, about $${items.cost.toFixed(2)}`}
          </Link>
        )}
      </div>
    })}
  </section>
}

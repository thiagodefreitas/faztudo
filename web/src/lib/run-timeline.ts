import type { Approval, Lane, Message, Run } from "../types"
import { gistOf } from "./run-sentence"
import { formatElapsed } from "./time"

export type StepTone = "info" | "ok" | "warn" | "danger"

export interface TimelineStep {
  key: string
  title: string
  detail?: string
  /** ISO time, when the step has one. */
  at?: string
  tone: StepTone
}

const STATE_TEXT: Record<Run["state"], string> = {
  queued: "Queued",
  running: "Running",
  waiting_approval: "Waiting for approval",
  verifying: "Verifying",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
}

const COUNT = new Intl.NumberFormat("en-US")

/** "51,500 tokens", or "Tokens unknown" when the CLI keeps no per-run log. */
export function tokensTitle(run: Run): string {
  const t = run.tokens
  if (!t) return "Tokens unknown"
  return `${COUNT.format(t.input + t.output + t.cache_read + t.cache_write + (t.total_only ?? 0))} tokens`
}

/** The split behind the total, plus the estimated cost when the lane has prices. */
export function tokensDetail(run: Run): string {
  const t = run.tokens
  if (!t) return "This CLI does not record usage per run, or it could not be told apart from another run."
  if (t.total_only) return "CLI total; input and output split unknown, so cost is unavailable."
  const split = `${COUNT.format(t.input)} in, ${COUNT.format(t.output)} out, ${COUNT.format(t.cache_read)} cache read, ${COUNT.format(t.cache_write)} cache write.`
  return run.cost_usd === undefined ? split : `${split} About $${run.cost_usd.toFixed(run.cost_usd < 0.01 ? 4 : 2)}, estimate, not billing.`
}

/** "codex/default skipped: no capacity" from a "Lane switched from ... to ..." notice. */
export function switchedWhy(text: string | undefined): string | undefined {
  const match = text ? /^Lane switched from (\S+) to \S+?\.\s*(.*)$/.exec(text) : null
  if (!match?.[1]) return undefined
  return match[2] ? `${match[1]} skipped: ${match[2]}` : `${match[1]} skipped`
}

/**
 * What happened in a run, in order, from the fields the run, its lane and its
 * approval already carry. Nothing here is invented: a step with no data is left out.
 */
export function runTimeline(input: {
  run: Run
  now: number
  trigger?: Message | undefined
  /** The failed run this one retried. */
  previous?: Run | undefined
  /** Why the lane was picked, from a lane notice. */
  why?: string | undefined
  lane?: Lane | undefined
  approval?: Approval | null | undefined
}): TimelineStep[] {
  const { run, now } = input
  const steps: TimelineStep[] = []
  if (input.trigger) {
    steps.push({ key: "request", title: "Request", detail: gistOf(input.trigger.body, 120), at: input.trigger.created_at, tone: "info" })
  }
  const reason =
    input.why ??
    (input.previous
      ? `Retry of the run on ${input.previous.lane_id}${input.previous.failure_reason ? `, which failed: ${input.previous.failure_reason}` : ""}.`
      : "The first lane in the persona's chain that was healthy and had a free slot.")
  steps.push({ key: "lane", title: `Lane ${run.lane_id}`, detail: reason, tone: "info" })
  if (run.started_at) steps.push({ key: "start", title: "Started", at: run.started_at, tone: "info" })
  if (run.diff_stat) {
    const { files, insertions, deletions } = run.diff_stat
    steps.push({
      key: "files",
      title: `${files} ${files === 1 ? "file" : "files"} changed`,
      detail: `+${insertions} -${deletions}`,
      tone: "info",
    })
  }
  if (run.verification) {
    steps.push({
      key: "tests",
      title: run.verification.ok ? "Tests passed" : "Tests failed",
      detail: run.verification.detail,
      tone: run.verification.ok ? "ok" : "danger",
    })
  }
  if (input.approval) {
    const resolution = input.approval.resolution
    steps.push({
      key: "approval",
      title: input.approval.state === "pending" ? "Waiting for your approval" : `Approval ${input.approval.state}`,
      ...(resolution ? { detail: `You chose ${resolution.option}.`, at: resolution.at } : {}),
      tone: input.approval.state === "pending" ? "warn" : "info",
    })
  }
  if (run.ended_at) {
    steps.push({
      key: "end",
      title: STATE_TEXT[run.state],
      detail: `${formatElapsed(run.started_at, run.ended_at, now)}${run.failure_reason ? `. ${run.failure_reason}` : ""}`,
      at: run.ended_at,
      tone: run.state === "done" ? "ok" : run.state === "failed" ? "danger" : "info",
    })
  } else {
    steps.push({ key: "now", title: STATE_TEXT[run.state], detail: formatElapsed(run.started_at, undefined, now), tone: "info" })
  }
  // Usage is read when the run ends, so a live run has none yet.
  if (run.tokens || run.ended_at) steps.push({ key: "usage", title: tokensTitle(run), detail: tokensDetail(run), tone: "info" })
  const cost = input.lane?.cost_today_usd
  if (cost !== undefined) {
    steps.push({
      key: "cost",
      title: `About $${cost.toFixed(2)} on this lane today, estimate`,
      detail: "This is the lane's estimate for the whole day, not billing.",
      tone: "info",
    })
  }
  return steps
}

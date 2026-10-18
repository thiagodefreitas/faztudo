import type { Approval, Run } from "../types"

function files(count: number): string {
  return `${count} ${count === 1 ? "file" : "files"}`
}

function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim()
  return line.length > max ? `${line.slice(0, max - 3).trimEnd()}...` : line
}

function tests(run: Run): string {
  if (!run.verification) return ""
  return run.verification.ok ? " Tests passed." : " Tests failed."
}

/**
 * One plain sentence that says what happened, built from fields the run
 * already has. "Coder changed 3 files. Tests passed. Waiting for you."
 */
export function runSentence(run: Run, name: string, approval?: Approval | null): string {
  const changed = run.diff_stat && run.diff_stat.files > 0 ? `${name} changed ${files(run.diff_stat.files)}.` : ""
  switch (run.state) {
    case "queued":
      return `${name} is queued.`
    case "running":
      return `${name} is working.`
    case "verifying":
      return `${name} is running the tests.`
    case "waiting_approval": {
      const wait = approval && approval.state !== "pending" ? "" : " Waiting for you."
      if (!changed) return `${name} is waiting for your approval.`
      return `${changed}${tests(run)}${wait}`
    }
    case "done":
      if (changed) return `${changed}${tests(run)}`
      return run.mode === "write" ? `${name} finished with no changes.` : `${name} answered.`
    case "failed": {
      if (changed && run.verification && !run.verification.ok) return `${changed} Tests failed.`
      const reason = run.failure_reason ? clip(run.failure_reason, 120) : "the run ended with an error"
      return `${name} failed: ${reason}`
    }
    case "cancelled":
      return `${name} was cancelled.`
  }
}

/** Short title for a run, the first words of the message that started it. */
export function gistOf(body: string | undefined, max = 48): string {
  if (!body) return ""
  const plain = body
    .replace(/^\s*@[\w-]+\s*/g, "")
    .replace(/^\/lane\s+\S+\s*/i, "")
    .replace(/\s+/g, " ")
    .trim()
  return clip(plain, max)
}

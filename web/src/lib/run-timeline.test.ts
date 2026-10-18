import { describe, expect, it } from "vitest"
import type { Lane, Message, Run } from "../types"
import { runTimeline, switchedWhy } from "./run-timeline"

const now = Date.parse("2026-10-18T12:00:00.000Z")

const run: Run = {
  id: "r2",
  channel_id: "c1",
  trigger_message_id: "m1",
  agent_id: "a1",
  lane_id: "codex/default",
  mode: "write",
  state: "done",
  started_at: "2026-10-18T11:55:00.000Z",
  ended_at: "2026-10-18T11:58:30.000Z",
  diff_stat: { files: 3, insertions: 12, deletions: 4 },
  verification: { ok: true, detail: "ok  ./..." },
}

const trigger = { id: "m1", body: "@coder Fix the login check", created_at: "2026-10-18T11:54:00.000Z" } as Message

describe("switchedWhy", () => {
  it("reads the skipped lane and the reason from a lane notice", () => {
    expect(switchedWhy("Lane switched from codex/default to claude/opus. no capacity")).toBe("codex/default skipped: no capacity")
    expect(switchedWhy("Lane switched from a/b to c/d.")).toBe("a/b skipped")
    expect(switchedWhy("Something else")).toBeUndefined()
    expect(switchedWhy(undefined)).toBeUndefined()
  })
})

describe("runTimeline", () => {
  it("walks a finished run from request to the end", () => {
    const steps = runTimeline({ run, now, trigger })
    expect(steps.map((step) => step.key)).toEqual(["request", "lane", "start", "files", "tests", "end", "usage"])
    expect(steps[0]?.detail).toBe("Fix the login check")
    expect(steps.find((step) => step.key === "files")?.detail).toBe("+12 -4")
    expect(steps.find((step) => step.key === "end")?.detail).toBe("3m 30s")
  })

  it("explains the lane: a notice first, then the retry link, then the default rule", () => {
    expect(runTimeline({ run, now, why: "claude/sonnet was skipped: busy" }).find((s) => s.key === "lane")?.detail).toBe(
      "claude/sonnet was skipped: busy",
    )
    const previous: Run = { ...run, id: "r1", lane_id: "kimi/default", state: "failed", failure_reason: "403 no access" }
    expect(runTimeline({ run, now, previous }).find((s) => s.key === "lane")?.detail).toBe(
      "Retry of the run on kimi/default, which failed: 403 no access.",
    )
    expect(runTimeline({ run, now }).find((s) => s.key === "lane")?.detail).toMatch(/first lane in the persona's chain/)
  })

  it("shows a live run as still going and leaves out what it lacks", () => {
    const live: Run = { id: "r3", channel_id: "c1", trigger_message_id: "m1", agent_id: "a1", lane_id: "x", mode: "read", state: "running", started_at: "2026-10-18T11:59:00.000Z" }
    const steps = runTimeline({ run: live, now })
    expect(steps.map((step) => step.key)).toEqual(["lane", "start", "now"])
    expect(steps.at(-1)?.detail).toBe("1m 00s")
  })

  it("shows the tokens and the estimated cost of this run when they are recorded", () => {
    const withUsage: Run = { ...run, tokens: { input: 1200, output: 300, cache_read: 50000, cache_write: 0 }, cost_usd: 0.1234 }
    const step = runTimeline({ run: withUsage, now }).find((s) => s.key === "usage")
    expect(step?.title).toBe("51,500 tokens")
    expect(step?.detail).toBe("1,200 in, 300 out, 50,000 cache read, 0 cache write. About $0.12, estimate, not billing.")
  })

  it("leaves tokens unknown when the CLI keeps no per-run log, and the cost out when there are no prices", () => {
    const unknown = runTimeline({ run, now }).find((s) => s.key === "usage")
    expect(unknown?.title).toBe("Tokens unknown")
    expect(unknown?.detail).toMatch(/does not record/)
    const noPrice: Run = { ...run, tokens: { input: 10, output: 5, cache_read: 0, cache_write: 0 } }
    expect(runTimeline({ run: noPrice, now }).find((s) => s.key === "usage")?.detail).not.toMatch(/\$/)
  })

  it("adds the lane cost estimate only when it is known, never as billing", () => {
    const lane = { id: "codex/default", cost_today_usd: 1.234 } as Lane
    const cost = runTimeline({ run, now, lane }).find((step) => step.key === "cost")
    expect(cost?.title).toBe("About $1.23 on this lane today, estimate")
    expect(cost?.detail).toMatch(/not billing/)
    expect(runTimeline({ run, now, lane: { id: "x" } as Lane }).some((step) => step.key === "cost")).toBe(false)
  })
})

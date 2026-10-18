import { describe, expect, it } from "vitest"
import type { Run } from "../types"
import { gistOf, runSentence } from "./run-sentence"

const base: Run = {
  id: "r1",
  channel_id: "c1",
  trigger_message_id: "m1",
  agent_id: "a1",
  lane_id: "claude/sonnet",
  mode: "write",
  state: "waiting_approval",
  diff_stat: { files: 3, insertions: 10, deletions: 2 },
  verification: { ok: true, detail: "ok" },
}

describe("runSentence", () => {
  it("leads with what changed, the tests and who is waiting", () => {
    expect(runSentence(base, "Coder")).toBe("Coder changed 3 files. Tests passed. Waiting for you.")
  })

  it("says one file in the singular and reports failing tests", () => {
    const run = { ...base, diff_stat: { files: 1, insertions: 1, deletions: 0 }, verification: { ok: false, detail: "x" } }
    expect(runSentence(run, "Coder")).toBe("Coder changed 1 file. Tests failed. Waiting for you.")
  })

  it("does not claim a wait once the approval is resolved", () => {
    const approval = { state: "resolved" } as never
    expect(runSentence(base, "Coder", approval)).toBe("Coder changed 3 files. Tests passed.")
  })

  it("covers the live states", () => {
    expect(runSentence({ ...base, state: "queued" }, "Coder")).toBe("Coder is queued.")
    expect(runSentence({ ...base, state: "running" }, "Coder")).toBe("Coder is working.")
    expect(runSentence({ ...base, state: "verifying" }, "Coder")).toBe("Coder is running the tests.")
  })

  it("covers the ended states", () => {
    expect(runSentence({ ...base, state: "done" }, "Coder")).toBe("Coder changed 3 files. Tests passed.")
    expect(runSentence({ ...base, state: "done", mode: "read", diff_stat: undefined, verification: undefined }, "Reviewer")).toBe(
      "Reviewer answered.",
    )
    expect(runSentence({ ...base, state: "done", diff_stat: undefined }, "Coder")).toBe("Coder finished with no changes.")
    expect(runSentence({ ...base, state: "cancelled" }, "Coder")).toBe("Coder was cancelled.")
  })

  it("puts the failure reason in the sentence, shortened", () => {
    const run = { ...base, state: "failed" as const, diff_stat: undefined, verification: undefined, failure_reason: "exit 1: boom" }
    expect(runSentence(run, "Coder")).toBe("Coder failed: exit 1: boom")
    const long = runSentence({ ...run, failure_reason: "x".repeat(300) }, "Coder")
    expect(long.length).toBeLessThan(140)
    expect(long.endsWith("...")).toBe(true)
  })

  it("names failing tests when the run changed files", () => {
    const run = { ...base, state: "failed" as const, verification: { ok: false, detail: "x" } }
    expect(runSentence(run, "Coder")).toBe("Coder changed 3 files. Tests failed.")
  })
})

describe("gistOf", () => {
  it("drops the mention and the lane override and shortens", () => {
    expect(gistOf("@coder /lane codex/default Fix the login check please")).toBe("Fix the login check please")
    expect(gistOf("@coder " + "word ".repeat(30)).length).toBeLessThanOrEqual(48)
    expect(gistOf(undefined)).toBe("")
  })
})

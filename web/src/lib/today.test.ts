import { afterEach, describe, expect, it } from "vitest"
import type { Approval, Channel, Lane, Member, Message, Run } from "../types"
import { buildToday, OPEN_KEY, readOpen, readSeen, resetLabel, SEEN_KEY, writeSeen } from "./today"

const now = new Date(2026, 9, 22, 10, 0, 0).getTime()
const min = 60_000
const at = (ms: number) => new Date(ms).toISOString()

const coder: Member = { id: "coder", kind: "agent", handle: "coder", display_name: "Coder", presence: "online" }
const dev: Channel = { id: "dev", name: "dev", kind: "team", visibility: "public", member_ids: [], unread: 0 }
const ops: Channel = { id: "ops", name: "ops", kind: "team", visibility: "public", member_ids: [], unread: 0 }

function run(id: string, patch: Partial<Run>): Run {
  return { id, channel_id: "dev", trigger_message_id: "m", agent_id: "coder", lane_id: "codex/default", mode: "write", state: "done", ...patch }
}

function lane(id: string, health: Lane["health"], resetsInMin?: number): Lane {
  return {
    id,
    cli: "codex",
    cost_class: "standard",
    capacity: 1,
    running: 0,
    health,
    runs_today: 0,
    windows: resetsInMin === undefined ? [] : [{ name: "5h", source: "probe", resets_at: at(now + resetsInMin * min) }],
  }
}

const base = { runs: [], approvals: [], questions: [], channels: [dev, ops], members: [coder], lanes: [], seen: now - 60 * min, now }

afterEach(() => localStorage.clear())

describe("buildToday needs", () => {
  it("lists pending approvals and unanswered questions oldest first", () => {
    const approvals: Approval[] = [
      { id: "a1", channel_id: "dev", requested_by: "coder", title: "Merge", detail: "", options: [], state: "pending" },
      { id: "a2", channel_id: "dev", requested_by: "coder", title: "Old", detail: "", options: [], state: "resolved" },
    ]
    const question: Message = { id: "q1", channel_id: "ops", author_id: "coder", body: "Which?", mentions: [], options: ["a"], created_at: at(now - 90 * min) }
    const today = buildToday({ ...base, approvals, questions: [question] })
    expect(today.needs.map((item) => item.id)).toEqual(["q1", "a1"])
    expect(today.needs[0]).toMatchObject({ kind: "question", channel: "ops", agent: "coder" })
    expect(today.needs[1]).toMatchObject({ kind: "approval", title: "Merge" })
  })

  it("is empty when nothing waits", () => {
    expect(buildToday(base).needs).toEqual([])
  })
})

describe("buildToday finished", () => {
  it("keeps runs that ended after the seen time, grouped by channel with failures first", () => {
    const runs = [
      run("r1", { started_at: at(now - 20 * min), ended_at: at(now - 10 * min), mode: "write", approval_option: "merge" }),
      run("r2", { started_at: at(now - 30 * min), ended_at: at(now - 25 * min), state: "failed", failure_reason: "verification failed" }),
      run("r3", { channel_id: "ops", started_at: at(now - 8 * min), ended_at: at(now - 5 * min), mode: "read" }),
      run("r4", { started_at: at(now - 3 * 60 * min), ended_at: at(now - 2 * 60 * min) }),
      run("r5", { channel_id: "ops", started_at: at(now - 15 * min), state: "waiting_approval" }),
    ]
    const { finished } = buildToday({ ...base, runs })
    expect(finished.map((group) => group.channel)).toEqual(["dev", "ops"])
    expect(finished[0]?.items.map((item) => [item.run.id, item.outcome])).toEqual([
      ["r2", "failed"],
      ["r1", "merged"],
    ])
    expect(finished[0]?.items[0]?.reason).toBe("verification failed")
    expect(finished[1]?.items.map((item) => [item.run.id, item.outcome])).toEqual([
      ["r3", "answer"],
      ["r5", "waiting"],
    ])
  })

  it("tells merged, kept and discarded write runs apart", () => {
    const runs = [
      run("r1", { ended_at: at(now - 5 * min), mode: "write", approval_option: "merge" }),
      run("r2", { ended_at: at(now - 4 * min), mode: "write", approval_option: "keep" }),
      run("r3", { ended_at: at(now - 3 * min), mode: "write", approval_option: "discard" }),
      run("r4", { ended_at: at(now - 2 * min), mode: "write" }),
    ]
    const outcomes = buildToday({ ...base, runs }).finished[0]?.items.map((item) => [item.run.id, item.outcome])
    expect(outcomes).toEqual([
      ["r4", "no_changes"],
      ["r3", "discarded"],
      ["r2", "kept"],
      ["r1", "merged"],
    ])
  })

  it("falls back to the failure class, then to a plain note", () => {
    const runs = [
      run("r1", { ended_at: at(now - 5 * min), state: "failed", failure_class: "transient" }),
      run("r2", { ended_at: at(now - 4 * min), state: "failed" }),
    ]
    const reasons = buildToday({ ...base, runs }).finished[0]?.items.map((item) => item.reason)
    expect(reasons).toEqual(["no reason recorded", "transient"])
  })

  it("puts a channel with a failure ahead of a newer clean one", () => {
    const runs = [
      run("r1", { channel_id: "ops", ended_at: at(now - 1 * min) }),
      run("r2", { ended_at: at(now - 30 * min), state: "failed" }),
    ]
    expect(buildToday({ ...base, runs }).finished.map((group) => group.channelId)).toEqual(["dev", "ops"])
  })
})

describe("buildToday running and lanes", () => {
  it("lists active runs", () => {
    const runs = [run("r1", { state: "running", started_at: at(now - min) }), run("r2", { state: "done", ended_at: at(now - min) })]
    expect(buildToday({ ...base, runs }).running.map((item) => item.run.id)).toEqual(["r1"])
  })

  it("shows exhausted and conserve lanes, and an unavailable one that resets today", () => {
    const lanes = [
      lane("a/ok", "available", 30),
      lane("b/low", "conserve", 120),
      lane("c/out", "exhausted", 55),
      lane("d/down", "unavailable", 60),
      lane("e/down", "unavailable", 3 * 24 * 60),
      lane("f/unk", "unknown"),
    ]
    const items = buildToday({ ...base, lanes }).lanes
    expect(items.map((item) => item.id)).toEqual(["c/out", "b/low", "d/down"])
    expect(resetLabel(items[0]!, now)).toBe("resets 10:55")
    expect(resetLabel({ id: "x", health: "exhausted", resetsAt: undefined, resetsToday: false }, now)).toBe("reset unknown")
  })
})

describe("stored times", () => {
  it("uses the last 12 hours on a first visit and the stored time after", () => {
    expect(readSeen(now)).toBe(now - 12 * 60 * min)
    writeSeen(now - 5 * min)
    expect(readSeen(now)).toBe(now - 5 * min)
  })

  it("ignores a bad stored value and defaults to open", () => {
    localStorage.setItem(SEEN_KEY, "yesterday")
    expect(readSeen(now)).toBe(now - 12 * 60 * min)
    expect(readOpen()).toBe(true)
    localStorage.setItem(OPEN_KEY, "0")
    expect(readOpen()).toBe(false)
  })
})

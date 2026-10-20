import { describe, expect, it } from "vitest"
import type { Member, Message, Run } from "../types"
import { fromHandle, groupWork, requestLine, workColumn } from "./all-work"

const NOW = Date.parse("2026-10-20T20:00:00Z")
const hours = (h: number) => new Date(NOW - h * 3600_000).toISOString()
const run = (id: string, state: Run["state"], over: Partial<Run> = {}): Run => ({
  id,
  channel_id: "c1",
  trigger_message_id: `m-${id}`,
  agent_id: "a1",
  lane_id: "codex/default",
  mode: "read",
  state,
  ...over,
})
const message = (id: string, author: string, body: string): Message => ({ id, channel_id: "c1", author_id: author, body, mentions: [], created_at: hours(1) })
const members: Member[] = [
  { id: "h1", kind: "human", handle: "ada", display_name: "Ada", presence: "online" },
  { id: "a1", kind: "agent", handle: "coder", display_name: "Coder", presence: "idle" },
  { id: "a2", kind: "agent", handle: "chief", display_name: "Chief", presence: "idle" },
]

describe("groupWork", () => {
  it("maps every state to one column", () => {
    expect(workColumn(run("a", "verifying"))).toBe("running")
    expect(workColumn(run("a", "waiting_approval"))).toBe("needs_you")
    expect(workColumn(run("a", "cancelled"))).toBe("failed")
    expect(workColumn(run("a", "queued"))).toBe("queued")
  })

  it("groups runs and drops those older than 24 hours", () => {
    const runs = [
      run("1", "queued", { started_at: hours(1) }),
      run("2", "running", { started_at: hours(2) }),
      run("3", "verifying", { started_at: hours(3) }),
      run("4", "done", { started_at: hours(5), ended_at: hours(4) }),
      run("5", "failed", { ended_at: hours(30) }),
      run("6", "cancelled", { ended_at: hours(6) }),
    ]
    const out = groupWork(runs, [], members, NOW)
    expect(out.queued.map((c) => c.run.id)).toEqual(["1"])
    expect(out.running.map((c) => c.run.id)).toEqual(["2", "3"])
    expect(out.done.map((c) => c.run.id)).toEqual(["4"])
    expect(out.failed.map((c) => c.run.id)).toEqual(["6"])
  })

  it("takes the first non-empty line of the trigger message", () => {
    const out = groupWork([run("1", "done", { ended_at: hours(1) })], [message("m-1", "h1", "\n  fix the build\nmore")], members, NOW)
    expect(out.done[0]?.request).toBe("fix the build")
    expect(out.done[0]?.from).toBeUndefined()
  })
})

describe("fromHandle", () => {
  it("names the agent that delegated", () => {
    expect(fromHandle(run("1", "done"), message("m", "a2", "do it"), members)).toBe("chief")
  })
  it("is empty for a human trigger, the run's own agent, or no message", () => {
    expect(fromHandle(run("1", "done"), message("m", "h1", "x"), members)).toBeUndefined()
    expect(fromHandle(run("1", "done"), message("m", "a1", "x"), members)).toBeUndefined()
    expect(fromHandle(run("1", "done"), undefined, members)).toBeUndefined()
  })
})

describe("requestLine", () => {
  it("skips the mention and lane override of a brief", () => {
    expect(requestLine("@coder /lane codex/default\n\nTask: add the context tab\nmore")).toBe("Task: add the context tab")
    expect(requestLine("@chief what runs now?")).toBe("what runs now?")
    expect(requestLine("@chief")).toBe("@chief")
  })
})

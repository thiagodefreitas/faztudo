import { describe, expect, it } from "vitest"
import type { Approval, Lane, Member, Message, Run } from "../types"
import { catchUpLine, channelActivity, isQuiet } from "./activity"

const coder: Member = {
  id: "a1",
  kind: "agent",
  handle: "coder",
  display_name: "Coder",
  presence: "busy",
  agent: { lanes: ["codex/default", "kimi/default"] },
}

const run = (id: string, state: Run["state"], channel = "c1"): Run => ({
  id,
  channel_id: channel,
  trigger_message_id: "m1",
  agent_id: "a1",
  lane_id: "codex/default",
  mode: "write",
  state,
})

const lane = (id: string, health: Lane["health"]): Lane => ({
  id,
  cli: "codex",
  cost_class: "standard",
  capacity: 1,
  running: 0,
  health,
  windows: [],
  runs_today: 0,
})

const approval = (id: string, state: Approval["state"], channel = "c1"): Approval => ({
  id,
  channel_id: channel,
  requested_by: "a1",
  title: "Merge",
  detail: "",
  options: [],
  state,
})

const message = { id: "m1", body: "@coder Fix the login check" } as Message

describe("channelActivity", () => {
  const input = {
    channelId: "c1",
    agentIds: ["a1"],
    runs: [run("r1", "running"), run("r2", "done"), run("r3", "running", "c2"), run("r4", "queued")],
    approvals: [approval("p1", "pending"), approval("p2", "resolved"), approval("p3", "pending", "c2")],
    lanes: [lane("codex/default", "available"), lane("kimi/default", "unavailable"), lane("other/x", "exhausted")],
    members: [coder],
    messages: [message],
  }

  it("lists live runs of this channel with who and what", () => {
    const activity = channelActivity(input)
    expect(activity.working.map((entry) => entry.run.id)).toEqual(["r1", "r4"])
    expect(activity.working[0]?.agent?.handle).toBe("coder")
    expect(activity.working[0]?.gist).toBe("Fix the login check")
  })

  it("counts only pending approvals of this channel", () => {
    expect(channelActivity(input).waiting.map((item) => item.id)).toEqual(["p1"])
  })

  it("flags lanes in trouble that this channel's agents use", () => {
    expect(channelActivity(input).trouble.map((item) => item.id)).toEqual(["kimi/default"])
  })

  it("is quiet when nothing is going on", () => {
    expect(isQuiet(channelActivity({ ...input, runs: [], approvals: [], lanes: [] }))).toBe(true)
    expect(isQuiet(channelActivity(input))).toBe(false)
  })
})

describe("catchUpLine", () => {
  it("is empty without unread messages", () => {
    expect(catchUpLine({ unread: 0, waiting: 2 })).toBeNull()
  })

  it("uses the channel summary and the approvals waiting", () => {
    expect(catchUpLine({ unread: 3, summary: "Coder merged the login fix. Reviewer is next.", waiting: 1 })).toBe(
      "3 new messages. Earlier: Coder merged the login fix. 1 waiting for you.",
    )
  })

  it("works without a summary", () => {
    expect(catchUpLine({ unread: 1, waiting: 0 })).toBe("1 new message.")
  })
})

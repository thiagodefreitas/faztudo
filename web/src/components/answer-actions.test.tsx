import { describe, expect, it } from "vitest"
import type { Member, Run } from "../types"
import { otherLanes, reviewers } from "./answer-actions"

const agent = (id: string, lanes: string[] = []): Member => ({
  id,
  kind: "agent",
  handle: id,
  display_name: id,
  presence: "idle",
  agent: { lanes },
})
const human: Member = { id: "h", kind: "human", handle: "me", display_name: "Me", presence: "online" }

describe("reviewers", () => {
  it("offers the other agents of the channel, not the author or humans", () => {
    const coder = agent("coder")
    const list = [coder, agent("reviewer"), agent("tester"), agent("outsider"), human]
    expect(reviewers(coder, list, ["coder", "reviewer", "tester", "h"]).map((item) => item.id)).toEqual(["reviewer", "tester"])
  })

  it("stops at four", () => {
    const many = ["a", "b", "c", "d", "e", "f"].map((id) => agent(id))
    expect(reviewers(undefined, many, ["a", "b", "c", "d", "e", "f"])).toHaveLength(4)
  })
})

describe("otherLanes", () => {
  const run = (state: Run["state"]): Run => ({
    id: "r",
    channel_id: "c",
    trigger_message_id: "m",
    agent_id: "coder",
    lane_id: "codex/default",
    mode: "read",
    state,
  })
  const coder = agent("coder", ["codex/default", "claude/sonnet"])

  it("lists the other lanes of the agent once the run has ended", () => {
    expect(otherLanes(coder, run("done"))).toEqual(["claude/sonnet"])
    expect(otherLanes(coder, run("failed"))).toEqual(["claude/sonnet"])
  })

  it("offers none for a live run or no run", () => {
    expect(otherLanes(coder, run("running"))).toEqual([])
    expect(otherLanes(coder, undefined)).toEqual([])
  })
})

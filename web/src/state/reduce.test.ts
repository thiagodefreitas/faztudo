import { describe, expect, it } from "vitest"
import type { Message, Run, StreamEvent } from "../types"
import { emptySnapshot, reduce, type Snapshot } from "./reduce"

const channelId = "01BRZ3NDEKTSV4RRFFQ69G5BB1"
const messageId = "01CRZ3NDEKTSV4RRFFQ69G5CC1"
const runId = "01DRZ3NDEKTSV4RRFFQ69G5DD1"

function envelope(seq: number, type: StreamEvent["type"], payload: unknown): StreamEvent {
  return {
    seq,
    id: `01EV${seq.toString().padStart(22, "A")}`.slice(0, 26),
    version: 1,
    type,
    actor: "system",
    channel_id: channelId,
    ts: "2026-10-18T12:00:00.000Z",
    payload,
  }
}

const message: Message = {
  id: messageId,
  channel_id: channelId,
  author_id: "01ARZ3NDEKTSV4RRFFQ69G5AA1",
  body: "hello",
  mentions: [],
  created_at: "2026-10-18T12:00:00.000Z",
}

const run: Run = {
  id: runId,
  channel_id: channelId,
  trigger_message_id: messageId,
  agent_id: "01ARZ3NDEKTSV4RRFFQ69G5AA2",
  lane_id: "codex/default",
  mode: "write",
  state: "running",
}

describe("reduce", () => {
  it("ignores a repeated or older seq", () => {
    let state = reduce(emptySnapshot(), envelope(2, "message.posted", message))
    const again = reduce(state, envelope(2, "message.posted", { ...message, body: "changed" }))
    expect(again).toBe(state)
    state = reduce(state, envelope(1, "notice", { level: "info", text: "late" }))
    expect(state.notices).toEqual([])
    expect(state.messages[channelId]?.[0]?.body).toBe("hello")
  })

  it("keeps the assign action of a notice and drops a malformed one", () => {
    const action = { kind: "assign", label: "Assign @reviewer to Faztudo", project: "faztudo", agent: "reviewer" }
    let state = reduce(emptySnapshot(), envelope(1, "notice", { level: "warn", text: "not assigned", action }))
    state = reduce(state, envelope(2, "notice", { level: "warn", text: "odd", action: { kind: "assign" } }))
    expect(state.notices[0]?.action).toEqual(action)
    expect(state.notices[1]?.text).toBe("odd")
    expect(state.notices[1]?.action).toBeUndefined()
  })

  it("upserts messages and edits them", () => {
    let state = reduce(emptySnapshot(), envelope(1, "message.posted", message))
    state = reduce(state, envelope(2, "message.posted", message))
    expect(state.messages[channelId]).toHaveLength(1)
    state = reduce(state, envelope(3, "message.edited", { id: messageId, body: "edited", edited_at: "2026-10-18T12:05:00.000Z" }))
    expect(state.messages[channelId]?.[0]?.body).toBe("edited")
    expect(state.messages[channelId]?.[0]?.edited_at).toBe("2026-10-18T12:05:00.000Z")
  })

  it("appends output once per line seq, even when the log seq is new", () => {
    let state: Snapshot = reduce(emptySnapshot(), envelope(1, "run.created", run))
    state = reduce(state, envelope(2, "run.output", { run_id: runId, seq: 1, stream: "stdout", text: "one" }))
    state = reduce(state, envelope(3, "run.output", { run_id: runId, seq: 1, stream: "stdout", text: "one again" }))
    state = reduce(state, envelope(4, "run.output", { run_id: runId, seq: 2, stream: "stderr", text: "two" }))
    expect(state.output[runId]).toEqual([
      { seq: 1, stream: "stdout", text: "one" },
      { seq: 2, stream: "stderr", text: "two" },
    ])
  })

  it("keeps the latest approval and updates presence", () => {
    const member = {
      id: "01ARZ3NDEKTSV4RRFFQ69G5AA2",
      kind: "agent" as const,
      handle: "coder",
      display_name: "Coder",
      presence: "online" as const,
    }
    const approval = {
      id: "01DRZ3NDEKTSV4RRFFQ69G5DD8",
      run_id: runId,
      channel_id: channelId,
      requested_by: member.id,
      title: "Push branch",
      detail: "push",
      options: [{ key: "push", label: "Push", style: "primary" as const }],
      state: "pending" as const,
    }
    let state = reduce(emptySnapshot(), envelope(1, "member.updated", member))
    state = reduce(state, envelope(2, "presence.changed", { member_id: member.id, presence: "busy" }))
    state = reduce(state, envelope(3, "approval.requested", approval))
    state = reduce(state, envelope(4, "approval.resolved", { ...approval, state: "resolved" }))
    expect(state.members[0]?.presence).toBe("busy")
    expect(state.approvals).toHaveLength(1)
    expect(state.approvals[0]?.state).toBe("resolved")
  })

  it("records a lane switch as a notice and moves the run", () => {
    let state = reduce(emptySnapshot(), envelope(1, "run.created", run))
    state = reduce(
      state,
      envelope(2, "lane.switched", { run_id: runId, from: "codex/default", to: "claude/opus", reason: "no capacity" }),
    )
    expect(state.runs[0]?.lane_id).toBe("claude/opus")
    expect(state.notices[0]?.text).toContain("claude/opus")
    expect(state.notices[0]?.text).toContain("no capacity")
  })

  it("counts a new reply on its cached root once", () => {
    const reply: Message = { ...message, id: "01CRZ3NDEKTSV4RRFFQ69G5CC9", thread_id: messageId, body: "reply" }
    let state = reduce(emptySnapshot(), envelope(1, "message.posted", message))
    state = reduce(state, envelope(2, "message.posted", reply))
    expect(state.messages[channelId]?.find((item) => item.id === messageId)?.reply_count).toBe(1)
    state = reduce(state, envelope(3, "message.posted", reply))
    expect(state.messages[channelId]?.find((item) => item.id === messageId)?.reply_count).toBe(1)
    expect(state.messages[channelId]).toHaveLength(2)
  })
})

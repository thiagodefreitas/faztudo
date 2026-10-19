import { describe, expect, it } from "vitest"
import type { Member, Message, Run } from "../types"
import { collectCount, countPieces, delegationLine, delegationLines, delegationPieces, pieceLabel, runForMessage, taskLine } from "./delegation"

const cos: Member = { id: "a0", kind: "agent", handle: "cos", display_name: "Chief of Staff", presence: "busy", agent: { lanes: ["claude/default"] } }
const coder: Member = { id: "a1", kind: "agent", handle: "coder", display_name: "Coder", presence: "busy", agent: { lanes: ["codex/default"] } }
const reviewer: Member = { id: "a2", kind: "agent", handle: "reviewer", display_name: "Reviewer", presence: "online", agent: { lanes: ["kimi/default"] } }
const members = [cos, coder, reviewer]

const root: Message = { id: "m0", channel_id: "c1", author_id: "h1", body: "@cos ship the login fix", mentions: ["a0"], created_at: "2026-10-18T10:00:00.000Z" }

function piece(id: string, to: string, body: string, at: string): Message {
  return {
    id,
    channel_id: "c1",
    thread_id: root.id,
    author_id: cos.id,
    body: `@${to} ${body}`,
    mentions: [],
    run_id: "r0",
    handoff: { request_id: root.id, from: "cos", to, depth: 1 },
    created_at: at,
  }
}

function run(id: string, trigger: string, state: Run["state"], extra: Partial<Run> = {}): Run {
  return { id, channel_id: "c1", trigger_message_id: trigger, agent_id: "a1", lane_id: "codex/default", mode: "write", state, ...extra }
}

const p1 = piece("m1", "coder", "Fix the login check\nMore detail below.", "2026-10-18T10:01:00.000Z")
const p2 = piece("m2", "reviewer", "Review the login fix", "2026-10-18T10:02:00.000Z")
const p3 = piece("m3", "coder", "Write the changelog line", "2026-10-18T10:03:00.000Z")
const plainReply: Message = { ...p2, id: "m4", body: "Done.", handoff: undefined, created_at: "2026-10-18T10:04:00.000Z" }

describe("taskLine", () => {
  it("drops the leading mention and keeps the first line", () => {
    expect(taskLine("@coder Fix the login check\nMore detail below.")).toBe("Fix the login check")
  })

  it("clips a long line", () => {
    expect(taskLine(`@coder ${"x".repeat(120)}`)).toHaveLength(96)
    expect(taskLine(`@coder ${"x".repeat(120)}`).endsWith("...")).toBe(true)
  })
})

describe("runForMessage", () => {
  it("prefers the retry over the run it replaced", () => {
    const runs = [run("r1", "m1", "failed"), run("r2", "m1", "running", { retry_of: "r1" }), run("r9", "m2", "done")]
    expect(runForMessage("m1", runs)?.id).toBe("r2")
    expect(runForMessage("m2", runs)?.id).toBe("r9")
    expect(runForMessage("m3", runs)).toBeNull()
  })
})

describe("delegationPieces", () => {
  it("lists handoff replies of the root with agent, task and run state", () => {
    const runs = [run("r1", "m1", "running"), run("r2", "m2", "done", { agent_id: "a2" }), run("r3", "m3", "failed")]
    const pieces = delegationPieces(root.id, [root, p3, plainReply, p1, p2], runs, members)
    expect(pieces.map((item) => item.id)).toEqual(["m1", "m2", "m3"])
    expect(pieces.map((item) => item.agent?.handle)).toEqual(["coder", "reviewer", "coder"])
    expect(pieces.map((item) => item.state)).toEqual(["running", "done", "failed"])
    expect(pieces[0]?.task).toBe("Fix the login check")
  })

  it("marks a piece without a run as pending", () => {
    const [only] = delegationPieces(root.id, [root, p1], [], members)
    expect(only?.state).toBe("pending")
    expect(only?.run).toBeNull()
    expect(pieceLabel(only?.state ?? "pending")).toBe("not started")
  })

  it("ignores replies under another root", () => {
    const elsewhere = { ...p1, id: "m8", thread_id: "other" }
    expect(delegationPieces(root.id, [elsewhere], [], members)).toEqual([])
  })

  // After a reload the channel holds roots only; a run that names the root
  // as its thread and is marked as a handoff stands in for the reply.
  it("finds a piece from its run alone when the reply is not loaded", () => {
    const runs = [
      run("r1", "m1", "failed", { thread_id: root.id, handoff: true }),
      run("r2", "m1", "done", { thread_id: root.id, handoff: true, retry_of: "r1" }),
      run("r3", "m2", "running", { thread_id: root.id, handoff: true, agent_id: "a2" }),
      // The collect run and a reply someone mentioned an agent in are in the thread but are not pieces.
      run("r4", "m7", "queued", { thread_id: root.id }),
      run("r5", "m8", "done", { thread_id: "other", handoff: true }),
    ]
    const pieces = delegationPieces(root.id, [root], runs, members)
    expect(pieces.map((item) => [item.id, item.run?.id, item.to, item.state, item.task])).toEqual([
      ["m1", "r2", "coder", "done", ""],
      ["m2", "r3", "reviewer", "running", ""],
    ])
    expect(pieces[0]?.message).toBeNull()
    expect(pieces[1]?.agent?.id).toBe("a2")
  })

  it("prefers the loaded reply over the run-only view of the same piece", () => {
    const runs = [run("r1", "m1", "done", { thread_id: root.id, handoff: true }), run("r3", "m2", "running", { thread_id: root.id, handoff: true, agent_id: "a2" })]
    const pieces = delegationPieces(root.id, [root, p1], runs, members)
    expect(pieces.map((item) => [item.id, item.task, item.message?.id ?? null])).toEqual([
      ["m1", "Fix the login check", "m1"],
      ["m2", "", null],
    ])
  })
})

describe("collectCount", () => {
  it("counts one result line per delegated piece", () => {
    const digest = "Write one combined answer.\n\nOriginal request:\n- @cos ship it\n\nDelegated results:\n- @coder: Fix the login check [done]\n  Fixed.\n- @reviewer: Review it [not started]\n  No run was started for this piece.\n"
    expect(collectCount(digest)).toBe(2)
    expect(collectCount("")).toBe(0)
  })
})

describe("countPieces and delegationLine", () => {
  it("counts one piece per state and names only the states present", () => {
    const runs = [run("r1", "m1", "running"), run("r2", "m2", "done"), run("r3", "m3", "failed")]
    const counts = countPieces(delegationPieces(root.id, [root, p1, p2, p3], runs, members))
    expect(counts).toEqual({ total: 3, running: 1, waiting: 0, done: 1, failed: 1, cancelled: 0, pending: 0 })
    expect(delegationLine(counts)).toBe("3 pieces: 1 running, 1 done, 1 failed")
  })

  it("folds queued and verifying into running and names waiting and not started", () => {
    const runs = [run("r1", "m1", "queued"), run("r2", "m2", "waiting_approval")]
    const counts = countPieces(delegationPieces(root.id, [root, p1, p2, p3], runs, members))
    expect(counts).toMatchObject({ total: 3, running: 1, waiting: 1, pending: 1 })
    expect(delegationLine(counts)).toBe("3 pieces: 1 running, 1 waiting for you, 1 not started")
    const verifying = countPieces(delegationPieces(root.id, [root, p1], [run("r1", "m1", "verifying")], members))
    expect(delegationLine(verifying)).toBe("1 piece: 1 running")
  })

  it("says cancelled and is null without pieces", () => {
    expect(delegationLine(countPieces(delegationPieces(root.id, [root, p1], [run("r1", "m1", "cancelled")], members)))).toBe("1 piece: 1 cancelled")
    expect(delegationLine(countPieces([]))).toBeNull()
  })

  it("maps every root with handoffs to its line", () => {
    const other: Message = { ...p1, id: "m9", thread_id: "m5", created_at: "2026-10-18T11:00:00.000Z" }
    const lines = delegationLines([root, p1, p2, other, plainReply], [run("r1", "m1", "done"), run("r9", "m9", "running")], members)
    expect([...lines.entries()]).toEqual([
      ["m0", "2 pieces: 1 done, 1 not started"],
      ["m5", "1 piece: 1 running"],
    ])
  })

  it("gives a root its line from handoff runs alone", () => {
    const runs = [run("r1", "m1", "done", { thread_id: root.id, handoff: true }), run("r2", "m2", "running", { thread_id: root.id, handoff: true }), run("r4", "m7", "queued", { thread_id: root.id })]
    expect([...delegationLines([root], runs, members).entries()]).toEqual([["m0", "2 pieces: 1 running, 1 done"]])
  })
})

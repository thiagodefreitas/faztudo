import { describe, expect, it } from "vitest"
import type { Approval, Channel, Member, Message, Project, Run } from "../types"
import { approvalRows, filterQuestions, filterRows, questionsWaiting } from "./approval-inbox"

const human = { id: "h1", kind: "human", handle: "thiago", display_name: "Thiago", presence: "online" } as Member
const coder = { id: "a1", kind: "agent", handle: "coder", display_name: "Coder", presence: "idle" } as Member
const reviewer = { id: "a2", kind: "agent", handle: "reviewer", display_name: "Reviewer", presence: "idle" } as Member
const members = [human, coder, reviewer]
const web = { id: "c1", name: "web" } as Channel
const api = { id: "c2", name: "api" } as Channel
const ops = { id: "c3", name: "ops" } as Channel
const projects = [
  { handle: "site", name: "Site", channels: ["web"] },
  { handle: "backend", name: "Backend", channels: ["api"] },
] as Project[]
const pending = (id: string, channel: string, run?: string, by = "a1"): Approval => ({
  id,
  channel_id: channel,
  requested_by: by,
  title: id,
  detail: "",
  state: "pending",
  options: [],
  ...(run ? { run_id: run } : {}),
})
const runs = [{ id: "r1", agent_id: "a2" }] as Run[]

describe("approvalRows", () => {
  it("lists pending approvals oldest first with their project and agent", () => {
    const rows = approvalRows(
      [pending("02", "c1"), pending("01", "c2", "r1"), { ...pending("00", "c1"), state: "resolved" }],
      [web, api],
      projects,
      runs,
      members,
    )
    expect(rows.map((r) => r.approval.id)).toEqual(["01", "02"])
    expect(rows[0]?.project?.handle).toBe("backend")
    expect(rows[0]?.agent?.handle).toBe("reviewer")
    expect(rows[1]?.agent?.handle).toBe("coder")
  })

  it("filters by project and by agent", () => {
    const rows = approvalRows(
      [pending("01", "c1"), pending("02", "c2", "r1"), pending("03", "c3")],
      [web, api, ops],
      projects,
      runs,
      members,
    )
    expect(filterRows(rows, { project: "site" }).map((r) => r.approval.id)).toEqual(["01"])
    expect(filterRows(rows, { agent: "a2" }).map((r) => r.approval.id)).toEqual(["02"])
    expect(filterRows(rows, { project: "site", agent: "a2" })).toEqual([])
    expect(filterRows(rows, {})).toHaveLength(3)
  })
})

describe("questionsWaiting", () => {
  const ask = (id: string, channel: string, options = ["A1", "B1"]): Message =>
    ({ id, channel_id: channel, author_id: "a1", body: "?", mentions: [], options, created_at: "", reply_count: 0 }) as Message
  const answer = (root: string): Message =>
    ({ id: `${root}r`, channel_id: "c1", thread_id: root, author_id: "h1", body: "B: B1", mentions: [], created_at: "" }) as Message

  it("lists unanswered agent questions and skips answered ones", () => {
    const list = questionsWaiting(
      [ask("02", "c1"), ask("01", "c2"), ask("03", "c1")],
      new Map([["03", [answer("03")]]]),
      [web, api],
      projects,
      members,
    )
    expect(list.map((q) => q.message.id)).toEqual(["01", "02"])
    expect(list[0]?.project?.handle).toBe("backend")
  })

  it("ignores plain messages, thread replies and human authors", () => {
    const plain = { ...ask("04", "c1"), options: undefined } as Message
    const reply = { ...ask("05", "c1"), thread_id: "01" } as Message
    const mine = { ...ask("06", "c1"), author_id: "h1" } as Message
    expect(questionsWaiting([plain, reply, mine], new Map(), [web], projects, members)).toEqual([])
  })

  it("filters like approvals", () => {
    const list = questionsWaiting([ask("01", "c1"), ask("02", "c2")], new Map(), [web, api], projects, members)
    expect(filterQuestions(list, { project: "site" }).map((q) => q.message.id)).toEqual(["01"])
    expect(filterQuestions(list, { agent: "a2" })).toEqual([])
  })
})

import { describe, expect, it } from "vitest"
import { digestItems } from "./digest"
import type { Approval, Channel, Project, Run, Task } from "../../types"

const project: Project = { handle: "p", name: "Project", channels: ["work"], departments: [], specialists: [] }
const channels: Channel[] = [{ id: "c", name: "work", kind: "project", visibility: "public", member_ids: [], unread: 0 }, { id: "other", name: "other", kind: "team", visibility: "public", member_ids: [], unread: 0 }]
const now = new Date("2026-10-18T12:00:00Z")
const run = (id: string, channel_id: string, ended_at: string, state: Run["state"]): Run => ({ id, channel_id, ended_at, state, trigger_message_id: "m", agent_id: "a", lane_id: "l", mode: "write" })

describe("project digest", () => {
  it("counts only project activity in each period and keeps unknown usage unknown", () => {
    const runs: Run[] = [
      { ...run("merged", "c", "2026-10-18T11:00:00Z", "done"), diff_stat: { files: 1, insertions: 2, deletions: 1 }, tokens: { input: 3, output: 2, cache_read: 1, cache_write: 0 }, cost_usd: 0.02 },
      run("failed", "c", "2026-10-15T11:00:00Z", "failed"),
      run("foreign", "other", "2026-10-18T11:00:00Z", "failed"),
    ]
    const approvals: Approval[] = [{ id: "a", channel_id: "c", requested_by: "agent", title: "Review", detail: "", options: [], state: "pending" }]
    const tasks: Task[] = [{ id: "t", channel_id: "c", title: "Done", assignee: "agent", mode: "write", scope: [], checks: [], acceptance: [], status: "done", order: 1, run_ids: [], created_by: "human", created_at: "2026-10-17T10:00:00Z", updated_at: "2026-10-18T10:00:00Z" }]
    const today = digestItems(project, channels, runs, approvals, tasks, "today", now)
    expect([today.merged.length, today.failed.length, today.waiting.length, today.tasks.length, today.tokens, today.cost]).toEqual([1, 0, 1, 1, 6, 0.02])
    const week = digestItems(project, channels, runs, approvals, tasks, "week", now)
    expect(week.failed.map((item) => item.id)).toEqual(["failed"])
    expect(digestItems(project, channels, [runs[1]!], [], [], "week", now).tokens).toBeUndefined()
  })
})

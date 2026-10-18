import { describe, expect, it } from "vitest"
import type { Approval, Channel, Member, Org, Project, Run } from "../types"
import { activeRuns, channelsOfProject, groupChannels, handleFromName, isAssigned, pendingApprovals, projectActivity, projectCounts, recentMerges, teamOf } from "./projects"

const channel = (id: string, name: string): Channel => ({
  id,
  name,
  kind: "team",
  visibility: "public",
  member_ids: [],
  unread: 0,
})

const project: Project = {
  handle: "faztudo",
  name: "Faztudo",
  lead: "architect",
  channels: ["Dev", "release"],
  departments: ["eng"],
  specialists: ["writer", "architect"],
}

const agent = (handle: string): Member => ({
  id: handle,
  kind: "agent",
  handle,
  display_name: handle,
  presence: "idle",
  agent: { lanes: [] },
})

const org: Org = {
  director_id: "me",
  departments: [{ handle: "eng", display_name: "Engineering", lead: "coder", members: ["coder", "reviewer"] }],
  projects: [project],
}

describe("channel grouping", () => {
  const channels = [channel("1", "dev"), channel("2", "general"), channel("3", "release")]

  it("matches channels to a project by name, ignoring case", () => {
    expect(channelsOfProject(project, channels).map((item) => item.id)).toEqual(["1", "3"])
  })

  it("leaves unlisted channels in the rest", () => {
    const grouped = groupChannels(channels, [project])
    expect(grouped.groups[0]?.channels.map((item) => item.name)).toEqual(["dev", "release"])
    expect(grouped.rest.map((item) => item.name)).toEqual(["general"])
  })
})

describe("pendingApprovals", () => {
  const approval = (id: string, state: Approval["state"], channelId: string) =>
    ({ id, state, channel_id: channelId }) as Approval

  it("counts pending ones, optionally for some channels", () => {
    const list = [approval("a", "pending", "1"), approval("b", "resolved", "1"), approval("c", "pending", "2")]
    expect(pendingApprovals(list)).toHaveLength(2)
    expect(pendingApprovals(list, new Set(["2"])).map((item) => item.id)).toEqual(["c"])
  })
})

describe("teamOf", () => {
  it("lists the lead, then the departments, then specialists, once each", () => {
    const members = ["architect", "coder", "reviewer", "writer"].map(agent)
    const team = teamOf(project, org, members).map((item) => `${item.member.handle}:${item.role}`)
    expect(team).toEqual(["architect:Lead", "coder:Engineering lead", "reviewer:Engineering", "writer:Specialist"])
  })
})

describe("runs of a project", () => {
  const run = (id: string, state: Run["state"], over: Partial<Run> = {}): Run => ({
    id,
    channel_id: "1",
    trigger_message_id: "m",
    agent_id: "a",
    lane_id: "l",
    mode: "write",
    state,
    ...over,
  })
  const ids = new Set(["1"])

  it("keeps the newest finished write runs with changes", () => {
    const stat = { files: 2, insertions: 1, deletions: 1 }
    const list = [
      run("old", "done", { diff_stat: stat, ended_at: "2026-10-18T10:00:00Z" }),
      run("new", "done", { diff_stat: stat, ended_at: "2026-10-18T11:00:00Z" }),
      run("none", "done"),
      run("read", "done", { mode: "read", diff_stat: stat }),
      run("elsewhere", "done", { channel_id: "9", diff_stat: stat }),
    ]
    expect(recentMerges(list, ids).map((item) => item.id)).toEqual(["new", "old"])
  })

  it("lists live runs including the ones waiting for approval", () => {
    const list = [run("a", "running"), run("b", "waiting_approval"), run("c", "done"), run("d", "running", { channel_id: "9" })]
    expect(activeRuns(list, ids).map((item) => item.id)).toEqual(["a", "b"])
  })
})

describe("isAssigned", () => {
  it("allows the lead, assigned specialists and the members of assigned departments", () => {
    expect(isAssigned(project, org.departments, "Architect")).toBe(true)
    expect(isAssigned(project, org.departments, "writer")).toBe(true)
    expect(isAssigned(project, org.departments, "reviewer")).toBe(true)
    expect(isAssigned({ ...project, departments: [] }, org.departments, "reviewer")).toBe(false)
    expect(isAssigned(project, org.departments, "stranger")).toBe(false)
  })
})

describe("projectActivity", () => {
  const run = (id: string, over: Partial<Run>): Run =>
    ({ id, channel_id: "1", trigger_message_id: "m", agent_id: "coder", lane_id: "l", mode: "write", state: "done", ...over }) as Run
  const approval = (id: string, option: string, at: string): Approval =>
    ({
      id,
      channel_id: "1",
      requested_by: "coder",
      title: "Push",
      detail: "",
      options: [
        { key: "push", label: "Push" },
        { key: "drop", label: "Drop", style: "danger" },
      ],
      state: "resolved",
      resolution: { option, by: "me", at },
    }) as Approval

  it("mixes merges, failures and answered approvals, newest first, in the project's channels only", () => {
    const runs = [
      run("merge", { diff_stat: { files: 1, insertions: 1, deletions: 0 }, ended_at: "2026-10-18T10:00:00Z" }),
      run("fail", { state: "failed", ended_at: "2026-10-18T12:00:00Z" }),
      run("read", { mode: "read", ended_at: "2026-10-18T13:00:00Z" }),
      run("elsewhere", { channel_id: "9", state: "failed", ended_at: "2026-10-18T14:00:00Z" }),
    ]
    const approvals = [approval("ok", "push", "2026-10-18T11:00:00Z"), approval("no", "drop", "2026-10-18T09:00:00Z"), { ...approval("open", "push", ""), state: "pending" as const }]
    const items = projectActivity(runs, approvals, new Set(["1"]))
    expect(items.map((item) => item.kind)).toEqual(["failure", "approved", "merge", "declined"])
    expect(projectActivity(runs, approvals, new Set(["1"]), 2)).toHaveLength(2)
  })
})

describe("projectCounts and handleFromName", () => {
  it("sums unread and counts waiting approvals", () => {
    const channels = [{ ...channel("1", "dev"), unread: 2 }, { ...channel("2", "release"), unread: 3 }]
    const approvals = [{ id: "a", state: "pending", channel_id: "1" } as Approval, { id: "b", state: "pending", channel_id: "9" } as Approval]
    expect(projectCounts(channels, approvals)).toEqual({ unread: 5, waiting: 1 })
  })

  it("turns a name into a handle", () => {
    expect(handleFromName("  Launch  Week 2 ")).toBe("launch-week-2")
    expect(handleFromName("Cafe Ole!")).toBe("cafe-ole")
  })
})

import type { Approval, Channel, Member, Org, Project, Run } from "../types"

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** Channels are listed under a project by name; a name no channel has is ignored. */
export function channelsOfProject(project: Project, channels: Channel[]): Channel[] {
  return channels.filter((channel) => project.channels.some((name) => same(name, channel.name)))
}

export function projectOfChannel(channel: Channel, projects: Project[]): Project | undefined {
  return projects.find((project) => project.channels.some((name) => same(name, channel.name)))
}

export interface ChannelGroups {
  groups: { project: Project; channels: Channel[] }[]
  /** Channels no project lists. */
  rest: Channel[]
}

export function groupChannels(channels: Channel[], projects: Project[]): ChannelGroups {
  const rest = channels.filter((channel) => !projectOfChannel(channel, projects))
  const groups = projects.map((project) => ({ project, channels: channelsOfProject(project, channels) }))
  return { groups, rest }
}

/** Approvals that wait for the human, the "Needs you" count. */
export function pendingApprovals(approvals: Approval[], channelIds?: Set<string>): Approval[] {
  return approvals.filter((approval) => approval.state === "pending" && (!channelIds || channelIds.has(approval.channel_id)))
}

export interface TeamMember {
  member: Member
  /** "Lead", a department name, or "Specialist". */
  role: string
}

/** The project lead first, then the members of its departments, then specialists. */
export function teamOf(project: Project, org: Org, members: Member[]): TeamMember[] {
  const out: TeamMember[] = []
  const seen = new Set<string>()
  const add = (handle: string | undefined, role: string) => {
    if (!handle) return
    const member = members.find((item) => same(item.handle, handle))
    if (!member || seen.has(member.id)) return
    seen.add(member.id)
    out.push({ member, role })
  }
  add(project.lead, "Lead")
  for (const handle of project.departments) {
    const department = org.departments.find((item) => same(item.handle, handle))
    if (!department) continue
    add(department.lead, `${department.display_name} lead`)
    for (const name of department.members) add(name, department.display_name)
  }
  for (const handle of project.specialists) add(handle, "Specialist")
  return out
}

/** Finished write runs that changed files, newest first. */
export function recentMerges(runs: Run[], channelIds: Set<string>, limit = 10): Run[] {
  return runs
    .filter((run) => channelIds.has(run.channel_id) && run.state === "done" && run.mode === "write" && (run.diff_stat?.files ?? 0) > 0)
    .sort((a, b) => (b.ended_at ?? "").localeCompare(a.ended_at ?? ""))
    .slice(0, limit)
}

const LIVE = new Set(["queued", "running", "verifying", "waiting_approval"])

export function activeRuns(runs: Run[], channelIds: Set<string>): Run[] {
  return runs.filter((run) => channelIds.has(run.channel_id) && LIVE.has(run.state))
}

/** The daemon's rule: the lead, an assigned specialist, or the lead or a member of an assigned department. */
export function isAssigned(project: Project, departments: Org["departments"], handle: string): boolean {
  if (same(project.lead ?? "", handle) || project.specialists.some((item) => same(item, handle))) return true
  return departments.some(
    (department) =>
      project.departments.some((item) => same(item, department.handle)) &&
      (same(department.lead ?? "", handle) || department.members.some((item) => same(item, handle))),
  )
}

export type ActivityKind = "merge" | "failure" | "approved" | "declined"

/** One line of a project's past: a merge, a failure, or an answered approval. */
export interface ActivityItem {
  kind: ActivityKind
  at: string
  run?: Run
  approval?: Approval
}

/** Recent merges, failures and answered approvals in the project's channels, newest first. */
export function projectActivity(runs: Run[], approvals: Approval[], channelIds: Set<string>, limit = 12): ActivityItem[] {
  const out: ActivityItem[] = []
  for (const run of runs) {
    if (!channelIds.has(run.channel_id)) continue
    if (run.state === "done" && run.mode === "write" && (run.diff_stat?.files ?? 0) > 0) out.push({ kind: "merge", at: run.ended_at ?? "", run })
    else if (run.state === "failed") out.push({ kind: "failure", at: run.ended_at ?? run.started_at ?? "", run })
  }
  for (const approval of approvals) {
    if (!channelIds.has(approval.channel_id) || approval.state !== "resolved" || !approval.resolution) continue
    const option = approval.options.find((item) => item.key === approval.resolution?.option)
    out.push({ kind: option?.style === "danger" ? "declined" : "approved", at: approval.resolution.at, approval })
  }
  return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit)
}

/** Unread messages and approvals waiting in a project's channels, for the rail. */
export function projectCounts(channels: Channel[], approvals: Approval[]): { unread: number; waiting: number } {
  const ids = new Set(channels.map((channel) => channel.id))
  return {
    unread: channels.reduce((sum, channel) => sum + channel.unread, 0),
    waiting: pendingApprovals(approvals, ids).length,
  }
}

/** A handle from a name: lowercase words joined by dashes. */
export function handleFromName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

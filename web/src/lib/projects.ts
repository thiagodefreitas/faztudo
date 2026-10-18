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

import { Link, getRouteApi } from "@tanstack/react-router"
import type { ReactNode } from "react"
import { runSentence } from "../lib/run-sentence"
import { activeRuns, channelsOfProject, pendingApprovals, recentMerges, teamOf } from "../lib/projects"
import { formatAge, formatElapsed } from "../lib/time"
import { useNow } from "../state/now"
import { useApprovals, useChannels, useMembers, useOrg, useRoutines, useRuns } from "../state/queries"
import type { Member } from "../types"
import { AgentAvatar } from "./agent-avatar"

const homeApi = getRouteApi("/p/$handle")

const LIST = "divide-y divide-line rounded-lg border border-line bg-surface"
const ROW = "flex min-h-10 items-center gap-2 px-3 py-1.5 text-[13px]"

function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section aria-label={title}>
      <h2 className="mb-1.5 flex items-baseline gap-2 text-[11px] font-medium uppercase tracking-wide text-faint">
        {title}
        {count !== undefined && <span className="font-mono normal-case">{count}</span>}
      </h2>
      {children}
    </section>
  )
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-dashed border-line px-3 py-2 text-[13px] text-muted">{children}</p>
}

/** The projects route at /p, for the phone's Projects tab. */
export function ProjectsIndexPage() {
  const org = useOrg()
  const projects = org.data?.projects ?? []
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex items-baseline gap-3 border-b border-line px-3 py-2">
        <h1 className="text-[15px] font-semibold">Projects</h1>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {projects.length === 0 ? (
          <Empty>No projects yet. Add [[project]] entries to lanes.toml.</Empty>
        ) : (
          <ul className={LIST}>
            {projects.map((project) => (
              <li key={project.handle}>
                <Link to="/p/$handle" params={{ handle: project.handle }} className={`${ROW} justify-between hover:bg-canvas`}>
                  <span className="font-medium">{project.name}</span>
                  <span className="font-mono text-[11px] text-faint">{project.channels.length} channels</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

export function ProjectHomePage() {
  const { handle } = homeApi.useParams()
  return <ProjectHome handle={handle} />
}

// One page for one project: what needs the Director, what runs now, the
// channels, the team, what merged lately, and the routines that post there.
export function ProjectHome({ handle }: { handle: string }) {
  const org = useOrg()
  const channels = useChannels()
  const members = useMembers()
  const runs = useRuns()
  const approvals = useApprovals()
  const routines = useRoutines()
  const now = useNow()

  const project = org.data?.projects.find((item) => item.handle.toLowerCase() === handle.toLowerCase())
  if (org.isPending) return <p className="p-4 text-[13px] text-muted">Loading project</p>
  if (!project || !org.data) return <p className="p-4 text-[13px] text-muted">Project not found.</p>

  const all = members.data ?? []
  const mine = channelsOfProject(project, channels.data ?? [])
  const ids = new Set(mine.map((channel) => channel.id))
  const nameOf = (id: string) => mine.find((channel) => channel.id === id)?.name ?? ""
  const memberOf = (id: string): Member | null => all.find((member) => member.id === id) ?? null
  const lead = all.find((member) => member.handle.toLowerCase() === (project.lead ?? "").toLowerCase())
  const waiting = pendingApprovals(approvals.data ?? [], ids)
  const active = activeRuns(runs.data ?? [], ids)
  const merges = recentMerges(runs.data ?? [], ids)
  const team = teamOf(project, org.data, all)
  const names = new Set(project.channels.map((name) => name.toLowerCase()))
  const projectRoutines = (routines.data ?? []).filter((routine) => names.has(routine.channel.toLowerCase()))
  const sorted = mine.slice().sort((a, b) => (b.last_seq ?? 0) - (a.last_seq ?? 0))

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="project-home">
      <header className="flex items-center gap-3 border-b border-line px-3 py-2">
        <Link to="/" className="min-h-10 py-2 text-[13px] text-muted md:hidden">
          Inbox
        </Link>
        <h1 className="min-w-0 flex-1 truncate text-[15px] font-semibold">{project.name}</h1>
        {lead && (
          <p className="flex items-center gap-1.5 text-[12px] text-muted">
            <AgentAvatar member={lead} size={20} decorative />
            Lead {lead.display_name}
          </p>
        )}
        <Link to="/organization" className="min-h-10 py-2 text-[13px] text-accent hover:underline md:min-h-0 md:py-0">
          Assign
        </Link>
      </header>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-3">
        <Section title="Needs you" count={waiting.length}>
          {waiting.length === 0 ? (
            <Empty>Nothing waits for you.</Empty>
          ) : (
            <ul className={LIST}>
              {waiting.map((approval) => (
                <li key={approval.id}>
                  <Link
                    to="/c/$channelId"
                    params={{ channelId: approval.channel_id }}
                    search={approval.run_id ? { run: approval.run_id } : {}}
                    className={`${ROW} hover:bg-canvas`}
                  >
                    <AgentAvatar member={memberOf(approval.requested_by)} size={20} state="waiting" decorative />
                    <span className="min-w-0 flex-1 truncate font-medium">{approval.title}</span>
                    <span className="text-muted">#{nameOf(approval.channel_id)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Active runs" count={active.length}>
          {active.length === 0 ? (
            <Empty>No run is active.</Empty>
          ) : (
            <ul className={LIST}>
              {active.map((run) => {
                const agent = memberOf(run.agent_id)
                return (
                  <li key={run.id}>
                    <Link
                      to="/c/$channelId"
                      params={{ channelId: run.channel_id }}
                      search={{ run: run.id }}
                      className={`${ROW} hover:bg-canvas`}
                    >
                      <AgentAvatar member={agent} size={20} state={run.state === "waiting_approval" ? "waiting" : "working"} decorative />
                      <span className="min-w-0 flex-1 truncate">{runSentence(run, agent?.display_name ?? "Agent")}</span>
                      <span className="font-mono text-[12px] tabular-nums text-muted">{formatElapsed(run.started_at, undefined, now)}</span>
                    </Link>
                  </li>
                )
              })}
            </ul>
          )}
        </Section>

        <Section title="Channels" count={sorted.length}>
          {sorted.length === 0 ? (
            <Empty>No channel of this project exists yet. Channels are matched by name.</Empty>
          ) : (
            <ul className={LIST}>
              {sorted.map((channel) => (
                <li key={channel.id}>
                  <Link to="/c/$channelId" params={{ channelId: channel.id }} className={`${ROW} hover:bg-canvas`}>
                    <span className="text-faint">#</span>
                    <span className="min-w-0 flex-1 truncate">{channel.name}</span>
                    {channel.unread > 0 && (
                      <span className="rounded-full bg-accent px-1.5 text-[11px] font-medium text-canvas" aria-label={`${channel.unread} unread`}>
                        {channel.unread}
                      </span>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Team" count={team.length}>
          {team.length === 0 ? (
            <Empty>Nobody is assigned yet.</Empty>
          ) : (
            <ul className={LIST}>
              {team.map(({ member, role }) => (
                <li key={member.id} className={ROW} data-agent={member.handle}>
                  <AgentAvatar member={member} size={28} state={member.presence === "busy" ? "working" : undefined} decorative />
                  <span className="min-w-0 flex-1 truncate font-medium">{member.display_name}</span>
                  <span className="text-[12px] text-muted">{role}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Recent merges" count={merges.length}>
          {merges.length === 0 ? (
            <Empty>Nothing has merged yet.</Empty>
          ) : (
            <ul className={LIST}>
              {merges.map((run) => {
                const agent = memberOf(run.agent_id)
                const stat = run.diff_stat
                return (
                  <li key={run.id}>
                    <Link
                      to="/c/$channelId"
                      params={{ channelId: run.channel_id }}
                      search={{ run: run.id, view: "diff" }}
                      className={`${ROW} hover:bg-canvas`}
                    >
                      <AgentAvatar member={agent} size={20} decorative />
                      <span className="min-w-0 flex-1 truncate">
                        {agent?.display_name ?? "Agent"} in #{nameOf(run.channel_id)}
                      </span>
                      {stat && (
                        <span className="font-mono text-[12px]">
                          <span className="text-ok">+{stat.insertions}</span> <span className="text-danger">-{stat.deletions}</span> in {stat.files}
                        </span>
                      )}
                      <span className="text-[12px] text-muted">{formatAge(run.ended_at, now)}</span>
                    </Link>
                  </li>
                )
              })}
            </ul>
          )}
        </Section>

        <Section title="Routines" count={projectRoutines.length}>
          {projectRoutines.length === 0 ? (
            <Empty>No routines yet.</Empty>
          ) : (
            <ul className={LIST}>
              {projectRoutines.map((routine) => (
                <li key={routine.handle} className={ROW}>
                  <span className="min-w-0 flex-1 truncate font-medium">{routine.name}</span>
                  <span className="text-[12px] text-muted">
                    {routine.enabled ? (routine.schedule ?? "on each message") : "off"}
                    {routine.last ? `, last ${routine.last.status}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </section>
  )
}

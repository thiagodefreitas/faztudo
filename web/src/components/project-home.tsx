import { Link, getRouteApi, useNavigate } from "@tanstack/react-router"
import { useState, type ReactNode } from "react"
import { cx } from "../lib/cx"
import { activeRuns, channelsOfProject, pendingApprovals, projectActivity, teamOf, type ActivityItem } from "../lib/projects"
import { runSentence } from "../lib/run-sentence"
import { formatAge, formatElapsed } from "../lib/time"
import { useNow } from "../state/now"
import { useApprovals, useChannels, useMe, useMembers, useOrg, useRoutines, useRuns } from "../state/queries"
import type { Member } from "../types"
import { AgentAvatar } from "./agent-avatar"
import { repoName } from "./channel"
import { CreateProjectDialog, CreateTeamChannelDialog } from "./project-dialogs"
import { TeamIcon } from "./team-icon"

const homeApi = getRouteApi("/p/$handle")

const LIST = "divide-y divide-line rounded-lg border border-line bg-surface"
const ROW = "flex min-h-10 items-center gap-2 px-3 py-1.5 text-[13px]"
const ACTION = "inline-flex min-h-8 items-center gap-1 rounded-md border border-line bg-surface px-2.5 text-[12px] font-medium text-ink hover:bg-sidebar"
const PRIMARY = "inline-flex min-h-8 items-center gap-1 rounded-md bg-accent px-2.5 text-[12px] font-medium text-canvas hover:opacity-90"

function Section({ title, count, action, children }: { title: string; count?: number; action?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title}>
      <h2 className="mb-1.5 flex items-baseline gap-2 text-[11px] font-medium uppercase tracking-wide text-faint">
        {title}
        {count !== undefined && <span className="font-mono normal-case">{count}</span>}
        {action && <span className="ml-auto normal-case tracking-normal">{action}</span>}
      </h2>
      {children}
    </section>
  )
}

// An empty section says what fills it and offers the one thing to do next.
function Empty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-line px-3 py-2.5 text-[13px] text-muted">
      <p className="min-w-0 flex-1">{children}</p>
      {action}
    </div>
  )
}

// Up to five overlapping faces and a "+N", the project's team at a glance.
function Faces({ members, size = 28 }: { members: Member[]; size?: 20 | 28 }) {
  const shown = members.slice(0, 5)
  const extra = members.length - shown.length
  return (
    <span className="inline-flex items-center" aria-hidden="true">
      {shown.map((member, index) => (
        <span key={member.id} style={{ marginLeft: index === 0 ? 0 : -Math.round(size * 0.3), zIndex: shown.length - index }} className="inline-flex rounded-lg ring-2 ring-canvas">
          <AgentAvatar member={member} size={size} state={member.presence === "busy" ? "working" : undefined} decorative />
        </span>
      ))}
      {extra > 0 && (
        <span
          style={{ marginLeft: -Math.round(size * 0.3), height: size, minWidth: size }}
          className="inline-flex items-center justify-center rounded-lg bg-line px-1 text-[11px] font-medium text-muted ring-2 ring-canvas"
        >
          +{extra}
        </span>
      )}
    </span>
  )
}

/** The projects route at /p, for the phone's Projects tab. */
export function ProjectsIndexPage() {
  const org = useOrg()
  const channels = useChannels()
  const members = useMembers()
  const approvals = useApprovals()
  const navigate = useNavigate()
  const [creating, setCreating] = useState(false)
  const projects = org.data?.projects ?? []
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b border-line px-3 py-2">
        <h1 className="min-w-0 flex-1 text-[15px] font-semibold">Projects</h1>
        <button type="button" onClick={() => setCreating(true)} className={PRIMARY}>
          New project
        </button>
      </header>
      <CreateProjectDialog open={creating} onOpenChange={setCreating} onCreated={(project) => void navigate({ to: "/p/$handle", params: { handle: project.handle } })} />
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {projects.length === 0 ? (
          <Empty action={<button type="button" onClick={() => setCreating(true)} className={ACTION}>New project</button>}>
            No projects yet. A project groups channels, a repository and the team that works there.
          </Empty>
        ) : (
          <ul className={LIST}>
            {projects.map((project) => {
              const mine = channelsOfProject(project, channels.data ?? [])
              const waiting = pendingApprovals(approvals.data ?? [], new Set(mine.map((channel) => channel.id))).length
              const team = org.data ? teamOf(project, org.data, members.data ?? []).map((item) => item.member) : []
              return (
                <li key={project.handle}>
                  <Link to="/p/$handle" params={{ handle: project.handle }} className={`${ROW} hover:bg-canvas`}>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{project.name}</span>
                      <span className="block truncate text-[12px] text-muted">
                        {mine.length} {mine.length === 1 ? "channel" : "channels"}, {team.length} on the team
                      </span>
                    </span>
                    {waiting > 0 && (
                      <span className="rounded-full bg-warn px-1.5 text-[11px] font-medium text-canvas" aria-label={`${waiting} waiting`}>
                        {waiting}
                      </span>
                    )}
                    <Faces members={team} size={20} />
                  </Link>
                </li>
              )
            })}
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

const KIND_DOT: Record<ActivityItem["kind"], string> = {
  merge: "bg-ok",
  failure: "bg-danger",
  approved: "bg-accent",
  declined: "bg-warn",
}

const KIND_GLYPH: Record<ActivityItem["kind"], string> = {
  merge: "+",
  failure: "x",
  approved: "v",
  declined: "-",
}

// One page for one project: what needs the Director, what runs now, the
// channels, the team, what happened lately, and the routines that post there.
export function ProjectHome({ handle }: { handle: string }) {
  const org = useOrg()
  const channels = useChannels()
  const members = useMembers()
  const me = useMe()
  const runs = useRuns()
  const approvals = useApprovals()
  const routines = useRoutines()
  const now = useNow()
  const navigate = useNavigate()
  const [creating, setCreating] = useState<string | null>(null)

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
  const activity = projectActivity(runs.data ?? [], approvals.data ?? [], ids)
  const team = teamOf(project, org.data, all)
  const names = new Set(project.channels.map((name) => name.toLowerCase()))
  const projectRoutines = (routines.data ?? []).filter((routine) => names.has(routine.channel.toLowerCase()))
  const sorted = mine.slice().sort((a, b) => (b.last_seq ?? 0) - (a.last_seq ?? 0))
  const missing = project.channels.filter((name) => !mine.some((channel) => channel.name.toLowerCase() === name.toLowerCase()))
  const first = sorted[0]
  const newChannel = (name = "") => setCreating(name)

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="project-home">
      <header className="border-b border-line px-3 py-2">
        <div className="flex items-center gap-3">
          <Link to="/" className="min-h-10 py-2 text-[13px] text-muted md:hidden">
            Inbox
          </Link>
          <div className="min-w-0 flex-1">
            <h1 className="flex min-w-0 items-baseline gap-2 text-[15px] font-semibold">
              <span className="truncate">{project.name}</span>
              <span className="shrink-0 font-mono text-[11px] font-normal text-faint">@{project.handle}</span>
            </h1>
            <p className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px] text-muted">
              {project.repo_path ? (
                <span className="font-mono" title={project.repo_path}>
                  {repoName(project.repo_path)}
                </span>
              ) : (
                <span>No repository</span>
              )}
              <span>
                {mine.length} {mine.length === 1 ? "channel" : "channels"}
              </span>
              <span>{team.length} on the team</span>
            </p>
          </div>
          {lead ? (
            <p className="hidden items-center gap-1.5 text-[12px] text-muted sm:flex" title={`Lead @${lead.handle}`}>
              <AgentAvatar member={lead} size={28} state={lead.presence === "busy" ? "working" : undefined} decorative />
              <span>
                <span className="block text-[11px] uppercase tracking-wide text-faint">Lead</span>
                <span className="block font-medium text-ink">{lead.display_name}</span>
              </span>
            </p>
          ) : (
            <Link to="/organization" className="hidden text-[12px] text-faint hover:underline sm:block">
              No lead yet
            </Link>
          )}
          {team.length > 0 && <Faces members={team.filter((item) => item.member.id !== lead?.id).map((item) => item.member)} />}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <button type="button" onClick={() => newChannel()} className={PRIMARY}>
            New channel
          </button>
          <Link to="/organization" className={ACTION}>
            Assign
          </Link>
          {first && (
            <Link to="/c/$channelId" params={{ channelId: first.id }} className={ACTION}>
              Open #{first.name}
            </Link>
          )}
        </div>
      </header>
      <CreateTeamChannelDialog
        key={creating ?? "closed"}
        project={project}
        initialName={creating ?? ""}
        open={creating !== null}
        onOpenChange={(open) => {
          if (!open) setCreating(null)
        }}
        onCreated={(channel) => void navigate({ to: "/c/$channelId", params: { channelId: channel.id } })}
      />
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="min-w-0 space-y-5">
            <Section title="Needs you" count={waiting.length}>
              {waiting.length === 0 ? (
                <Empty>Nothing waits for you. Approvals the team asks for in this project land here.</Empty>
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
                <Empty
                  action={
                    first && (
                      <Link to="/c/$channelId" params={{ channelId: first.id }} className={ACTION}>
                        Open #{first.name}
                      </Link>
                    )
                  }
                >
                  No run is active. Mention a team member or @{project.handle} in a channel to start one.
                </Empty>
              ) : (
                <ul className={LIST}>
                  {active.map((run) => {
                    const agent = memberOf(run.agent_id)
                    return (
                      <li key={run.id}>
                        <Link to="/c/$channelId" params={{ channelId: run.channel_id }} search={{ run: run.id }} className={`${ROW} hover:bg-canvas`}>
                          <AgentAvatar member={agent} size={20} state={run.state === "waiting_approval" ? "waiting" : "working"} decorative />
                          <span className="min-w-0 flex-1 truncate">{runSentence(run, agent?.display_name ?? "Agent")}</span>
                          <span className="hidden text-[12px] text-muted sm:inline">#{nameOf(run.channel_id)}</span>
                          <span className="font-mono text-[12px] tabular-nums text-muted">{formatElapsed(run.started_at, undefined, now)}</span>
                        </Link>
                      </li>
                    )
                  })}
                </ul>
              )}
            </Section>

            <Section
              title="Channels"
              count={sorted.length}
              action={
                <button type="button" onClick={() => newChannel()} className="text-[12px] font-medium text-accent hover:underline">
                  New channel
                </button>
              }
            >
              {sorted.length === 0 && missing.length === 0 ? (
                <Empty action={<button type="button" onClick={() => newChannel()} className={ACTION}>New channel</button>}>
                  No channel yet. Create the first one; you and the team become its members.
                </Empty>
              ) : (
                <ul className={LIST}>
                  {sorted.map((channel) => (
                    <li key={channel.id}>
                      <Link to="/c/$channelId" params={{ channelId: channel.id }} className={`${ROW} hover:bg-canvas`}>
                        {channel.member_ids.some((id) => id !== me.data?.id) ? (
                          <TeamIcon channel={channel} members={all} excludeId={me.data?.id} size={20} layout="cluster" />
                        ) : (
                          <span className="inline-flex w-5 justify-center text-faint">#</span>
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{channel.name}</span>
                          {channel.topic && <span className="block truncate text-[12px] text-muted">{channel.topic}</span>}
                        </span>
                        {channel.unread > 0 && (
                          <span className="rounded-full bg-accent px-1.5 text-[11px] font-medium text-canvas" aria-label={`${channel.unread} unread`}>
                            {channel.unread}
                          </span>
                        )}
                      </Link>
                    </li>
                  ))}
                  {missing.map((name) => (
                    <li key={name} className={cx(ROW, "text-muted")}>
                      <span className="text-faint">#</span>
                      <span className="min-w-0 flex-1 truncate">{name}</span>
                      <span className="text-[12px]">Listed, not created</span>
                      <button type="button" onClick={() => newChannel(name)} className="text-[12px] font-medium text-accent hover:underline">
                        Create
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section title="Activity" count={activity.length}>
              {activity.length === 0 ? (
                <Empty>Nothing happened yet. Merges, failures and the approvals you answered show up here.</Empty>
              ) : (
                <ol className="relative ml-2 border-l border-line pl-4" aria-label="Activity timeline">
                  {activity.map((item) => {
                    const run = item.run
                    const agent = run ? memberOf(run.agent_id) : memberOf(item.approval?.requested_by ?? "")
                    const channelId = run?.channel_id ?? item.approval?.channel_id ?? ""
                    const who = agent?.display_name ?? "Agent"
                    const stat = run?.diff_stat
                    let text = ""
                    if (item.kind === "merge") text = `${who} merged in #${nameOf(channelId)}`
                    else if (item.kind === "failure") text = `${who} failed in #${nameOf(channelId)}${run?.failure_reason ? `: ${run.failure_reason}` : ""}`
                    else text = `You ${item.kind} "${item.approval?.title ?? ""}"`
                    const search = run ? { run: run.id, ...(item.kind === "merge" ? { view: "diff" as const } : {}) } : item.approval?.run_id ? { run: item.approval.run_id } : {}
                    return (
                      <li key={`${item.kind}-${run?.id ?? item.approval?.id}`} className="relative py-1">
                        <span
                          className={cx(
                            "absolute -left-[25px] top-[9px] inline-flex h-4 w-4 items-center justify-center rounded-full font-mono text-[10px] font-bold leading-none text-canvas ring-2 ring-canvas",
                            KIND_DOT[item.kind],
                          )}
                          aria-hidden="true"
                        >
                          {KIND_GLYPH[item.kind]}
                        </span>
                        <Link to="/c/$channelId" params={{ channelId }} search={search} className="flex min-h-7 items-center gap-2 rounded-md px-1 text-[13px] hover:bg-surface">
                          <AgentAvatar member={agent} size={20} decorative />
                          <span className="min-w-0 flex-1 truncate">{text}</span>
                          {stat && item.kind === "merge" && (
                            <span className="hidden font-mono text-[12px] sm:inline">
                              <span className="text-ok">+{stat.insertions}</span> <span className="text-danger">-{stat.deletions}</span> in {stat.files}
                            </span>
                          )}
                          <span className="shrink-0 text-[12px] text-muted">{formatAge(item.at, now)}</span>
                        </Link>
                      </li>
                    )
                  })}
                </ol>
              )}
            </Section>
          </div>

          <div className="min-w-0 space-y-5">
            <Section
              title="Team"
              count={team.length}
              action={
                <Link to="/organization" className="text-[12px] font-medium text-accent hover:underline">
                  Assign
                </Link>
              }
            >
              {team.length === 0 ? (
                <Empty
                  action={
                    <Link to="/organization" className={ACTION}>
                      Assign
                    </Link>
                  }
                >
                  Nobody is assigned yet. Assign a department or specialists so they can run here.
                </Empty>
              ) : (
                <ul className={LIST}>
                  {team.map(({ member, role }) => (
                    <li key={member.id} className={ROW} data-agent={member.handle}>
                      <AgentAvatar member={member} size={28} state={member.presence === "busy" ? "working" : undefined} decorative />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{member.display_name}</span>
                        <span className="block truncate text-[12px] text-muted">{member.agent?.role ?? (member.kind === "human" ? "Human" : "")}</span>
                      </span>
                      <span className={cx("shrink-0 rounded px-1.5 text-[11px]", role === "Lead" ? "bg-accent-soft text-accent" : "bg-sidebar text-muted")}>{role}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section title="Routines" count={projectRoutines.length}>
              {projectRoutines.length === 0 ? (
                <Empty
                  action={
                    <Link to="/routines" className={ACTION}>
                      Routines
                    </Link>
                  }
                >
                  No routine posts here yet. A daily debrief is a good first one.
                </Empty>
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
        </div>
      </div>
    </section>
  )
}

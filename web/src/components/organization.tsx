import { useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { useState, type ReactNode } from "react"
import { api } from "../api/client"
import { cx } from "../lib/cx"
import { qk } from "../state/keys"
import { useNow } from "../state/now"
import { useApprovals, useComputers, useLanes, useMe, useMembers, useOrg, useRuns } from "../state/queries"
import type { AssignKind, Department, Member, Project } from "../types"
import { AgentAvatar } from "./agent-avatar"
import { LessonsButton } from "./lessons/lessons-dialog"
import { avatarState } from "./office/avatar"
import { deriveMemberDesk, type DeskInfo, type DeskState } from "./office/state"
import { CreateProjectDialog } from "./project-dialogs"
import { useProfileNavigation } from "./profile/navigation"
import { CARD as CARD_BASE, EmptyState, PageHeader, PRIMARY_BUTTON, SECONDARY_BUTTON, SECTION_LABEL } from "./page-header"

const CARD = `${CARD_BASE} min-w-0 p-4`
const CHIP = "inline-flex items-center rounded-full bg-sidebar px-2 py-0.5 text-[11px] text-muted"
const HEADING = `pb-2 ${SECTION_LABEL}`

const STATE_CLASS: Record<DeskState, string> = {
  idle: "bg-sidebar text-muted",
  working: "bg-accent-soft text-accent",
  queued: "bg-sidebar text-muted",
  waiting_approval: "bg-warn-soft text-warn",
  failed: "bg-danger-soft text-danger",
  out_of_quota: "bg-sidebar text-faint",
}

function sameHandle(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

// The specialists a project reaches through a department: lead and members.
function departmentHandles(department: Department): string[] {
  return [...(department.lead ? [department.lead] : []), ...department.members.filter((m) => !sameHandle(m, department.lead ?? ""))]
}

function AgentRow({
  handle,
  member,
  desk,
  badge,
  action,
}: {
  handle: string
  member: Member | undefined
  desk: DeskInfo | undefined
  badge?: string
  action?: ReactNode
}) {
  const { openProfile } = useProfileNavigation()
  // Lessons are the Director's to read and teach.
  const human = useMe().data?.kind === "human"
  return (
    <li className="flex min-h-10 flex-wrap items-center gap-2 py-1" data-agent={handle}>
      {member ? (
        <button type="button" onClick={() => openProfile(handle)} aria-label={`Profile: @${handle}`} className="flex shrink-0 rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"><AgentAvatar member={member} size={28} state={desk ? avatarState(desk.state) : undefined} decorative /></button>
      ) : (
        <span className="inline-block h-7 w-7 rounded-md bg-sidebar" aria-hidden="true" />
      )}
      <div className="min-w-0 flex-1 basis-40">
        <p className="flex items-center gap-2 text-[13px]">
          <button type="button" onClick={() => openProfile(handle)} className="truncate rounded font-medium hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">{member?.display_name ?? handle}</button>
          <span className="font-mono text-[11px] text-faint">@{handle}</span>
          {badge && <span className="rounded bg-accent-soft px-1.5 text-[11px] text-accent">{badge}</span>}
        </p>
        <p className="truncate text-[12px] text-muted">
          {member?.agent?.role ?? member?.agent?.description ?? "Not found among the members"}
          {desk?.laneId && <span className="font-mono"> {desk.laneId}</span>}
        </p>
      </div>
      {desk && (
        <span className={cx("shrink-0 rounded-full px-2 py-0.5 text-[11px]", STATE_CLASS[desk.state])}>{desk.stateLabel}</span>
      )}
      {member && human && (
        <LessonsButton
          persona={member.handle}
          className="min-h-10 shrink-0 rounded px-2 text-[12px] text-muted hover:bg-canvas hover:text-ink md:min-h-7"
        />
      )}
      {action}
    </li>
  )
}

export function OrganizationPage() {
  const me = useMe()
  const computers = useComputers(me.data?.kind === "human")
  const members = useMembers()
  const org = useOrg()
  const lanes = useLanes()
  const runs = useRuns()
  const approvals = useApprovals()
  const now = useNow()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  async function resetComputer(id: string) {
    const confirmed = window.confirm(`Reset @${id}'s computer? This removes its home and caches. It cannot undo OAuth changes, shared git objects, or anything already sent over the network.`)
    if (!confirmed) return
    setError(null)
    try {
      await api.resetComputer(id)
      await qc.invalidateQueries({ queryKey: qk.computers })
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not reset the computer.")
    }
  }

  const all = members.data ?? []
  const director = all.find((member) => member.id === (org.data?.director_id ?? me.data?.id))
  const agents = all.filter((member) => member.kind === "agent")
  const chiefs = agents.filter((member) => member.agent?.chief_of_staff)
  const byHandle = (handle: string) => agents.find((member) => sameHandle(member.handle, handle))
  const deskOf = (member: Member | undefined) =>
    member ? deriveMemberDesk({ member, runs: runs.data ?? [], approvals: approvals.data ?? [], lanes: lanes.data ?? [], now }) : undefined

  async function change(work: () => Promise<unknown>) {
    setError(null)
    try {
      await work()
      await qc.invalidateQueries({ queryKey: qk.org })
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not change the assignment.")
    }
  }

  const departments = org.data?.departments ?? []
  const projects = org.data?.projects ?? []
  const activeProjects = projects.filter((project) => !project.archived)
  const archivedProjects = projects.filter((project) => project.archived)

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHeader
        title="Organization"
        description={
          <>
            Who works where, and who leads. <span className="tabular-nums">{departments.length}</span> {departments.length === 1 ? "department" : "departments"},{" "}
            <span className="tabular-nums">{activeProjects.length}</span> {activeProjects.length === 1 ? "project" : "projects"}.
          </>
        }
        actions={
          <>
            <Link to="/routines" className={SECONDARY_BUTTON}>
              Routines
            </Link>
            <button type="button" onClick={() => setCreating(true)} className={PRIMARY_BUTTON}>
              New project
            </button>
          </>
        }
      />
      <CreateProjectDialog open={creating} onOpenChange={setCreating} onCreated={(project) => void navigate({ to: "/p/$handle", params: { handle: project.handle } })} />
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-4">
        {error && (
          <p role="alert" className="text-[13px] text-danger">
            {error}
          </p>
        )}
        {org.isPending ? (
          <p className="text-[13px] text-muted">Loading organization</p>
        ) : (
          <>
            {(director || chiefs.length > 0) && (
              <div className={cx("grid items-start gap-3", chiefs.length > 0 && director && "lg:grid-cols-2")}>
                {director && (
                  <div className={cx(CARD, "flex items-center gap-3")} data-testid="director">
                    <AgentAvatar member={director} size={36} decorative />
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 text-[14px] font-semibold">
                        {director.display_name}
                        <span className="rounded-full bg-accent-soft px-2 text-[11px] font-medium text-accent">Director</span>
                      </p>
                      <p className="text-[12px] text-muted">Assigns teams to projects and answers judgment calls.</p>
                    </div>
                  </div>
                )}
                {chiefs.length > 0 && (
                  <div className={CARD} data-testid="chief-of-staff">
                    <h2 className={SECTION_LABEL}>Chief of Staff</h2>
                    <p className="pb-1 pt-0.5 text-[12px] text-muted">
                      Gets messages that are not addressed to anyone, in channels that opted in, and hands them to the right agent in a thread.
                    </p>
                    <ul className="divide-y divide-line">
                      {chiefs.map((chief) => (
                        <AgentRow key={chief.id} handle={chief.handle} member={chief} desk={deskOf(chief)} badge="Chief of Staff" />
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}

            <div>
              <h2 className={HEADING}>Departments</h2>
              {departments.length === 0 ? (
                <EmptyState>
                  No departments yet. Add <code className="font-mono">[[department]]</code> entries to lanes.toml to group agents under a lead.
                </EmptyState>
              ) : (
                <div className="grid items-start gap-3 lg:grid-cols-2 2xl:grid-cols-3">
                  {departments.map((department) => {
                    const worksOn = activeProjects.filter((project) => project.departments.some((h) => sameHandle(h, department.handle)))
                    return (
                    <article
                      key={department.handle}
                      aria-label={department.display_name}
                      className={CARD}
                    >
                      <h3 className="flex items-baseline gap-2 text-[14px] font-semibold">
                        {department.display_name}
                        <span className="font-mono text-[11px] font-normal text-faint">@{department.handle}</span>
                        <span className="ml-auto font-mono text-[11px] font-normal text-faint">{departmentHandles(department).length}</span>
                      </h3>
                      <p className="pb-1 text-[12px] text-muted">
                        {department.lead ? (
                          <>
                            @{department.handle} goes to its lead, who splits the work.
                          </>
                        ) : (
                          "No lead: @" + department.handle + " reaches nobody yet."
                        )}
                      </p>
                      <ul className="divide-y divide-line">
                        {departmentHandles(department).map((handle) => {
                          const member = byHandle(handle)
                          return (
                            <AgentRow
                              key={handle}
                              handle={handle}
                              member={member}
                              desk={deskOf(member)}
                              {...(sameHandle(handle, department.lead ?? "") ? { badge: "Lead" } : {})}
                            />
                          )
                        })}
                      </ul>
                      <p className="flex flex-wrap items-center gap-1 pt-2 text-[12px] text-muted">
                        <span className="text-faint">Works on</span>
                        {worksOn.length === 0 ? (
                          <span>no project yet</span>
                        ) : (
                          worksOn.map((project) => (
                            <Link key={project.handle} to="/p/$handle" params={{ handle: project.handle }} className={cx(CHIP, "hover:text-ink")}>
                              {project.name}
                            </Link>
                          ))
                        )}
                      </p>
                    </article>
                    )
                  })}
                </div>
              )}
            </div>

            <div>
              <h2 className={cx("flex items-baseline gap-2", HEADING)}>
                Projects
                <button type="button" onClick={() => setCreating(true)} className="ml-auto text-[12px] font-medium normal-case tracking-normal text-accent hover:underline">
                  New project
                </button>
              </h2>
              {activeProjects.length === 0 ? (
                <EmptyState
                  action={
                    <button type="button" onClick={() => setCreating(true)} className={SECONDARY_BUTTON}>
                      New project
                    </button>
                  }
                >
                  No projects yet. Create one here or add <code className="font-mono">[[project]]</code> entries to lanes.toml.
                </EmptyState>
              ) : (
                <div className="grid items-start gap-3 lg:grid-cols-2 2xl:grid-cols-3">
                  {activeProjects.map((project) => (
                    <ProjectCard
                      key={project.handle}
                      project={project}
                      departments={departments}
                      agents={agents}
                      byHandle={byHandle}
                      deskOf={deskOf}
                      onAssign={(kind, handle) => void change(() => api.assign(project.handle, { kind, handle }))}
                      onUnassign={(kind, handle) => void change(() => api.unassign(project.handle, kind, handle))}
                    />
                  ))}
                </div>
              )}
            </div>
            {me.data?.kind === "human" && agents.length > 0 && (
              <section aria-label="Agent computers">
                <h2 className={HEADING}>Agent computers</h2>
                <ul className={cx(CARD_BASE, "divide-y divide-line px-4")}>
                  {agents.map((agent) => {
                    const computer = computers.data?.find((item) => sameHandle(item.id, agent.handle))
                    return (
                      <li key={agent.id} className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 py-1.5 text-[12px] text-muted">
                        <AgentAvatar member={agent} size={20} decorative />
                        <span className="min-w-0 flex-1 truncate font-medium text-ink">@{agent.handle}</span>
                        <span className={cx("rounded-full px-2 text-[11px]", computer && computer.state !== "off" ? "bg-sidebar text-muted" : "text-faint")}>{computer?.state ?? "off"}</span>
                        {computer && <span className="tabular-nums">{`${(computer.disk_bytes / 1048576).toFixed(1)} MB used`}</span>}
                        {computer?.last_reset && <span className="tabular-nums">Reset {new Date(computer.last_reset).toLocaleString()}</span>}
                        {computer && computer.state !== "off" && (
                          <button
                            type="button"
                            className="min-h-10 rounded-md px-2 font-medium text-accent transition-colors duration-150 hover:bg-sidebar md:min-h-7"
                            onClick={() => void resetComputer(agent.handle)}
                          >
                            Reset @{agent.handle}
                          </button>
                        )}
                      </li>
                    )
                  })}
                </ul>
              </section>
            )}

            {archivedProjects.length > 0 && (
              <section aria-label="Archived">
                <h2 className={HEADING}>Archived</h2>
                <ul className={cx(CARD_BASE, "divide-y divide-line")}>
                  {archivedProjects.map((project) => (
                    <li key={project.handle} className="flex min-h-10 items-center gap-3 px-3 py-1.5 text-[13px]">
                      <Link to="/p/$handle" params={{ handle: project.handle }} className="min-w-0 flex-1 truncate hover:underline">{project.name}</Link>
                      <button type="button" className="text-accent hover:underline" onClick={() => void change(() => api.patchProject(project.handle, { archived: false }))}>Unarchive</button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
    </section>
  )
}

function ProjectCard({
  project,
  departments,
  agents,
  byHandle,
  deskOf,
  onAssign,
  onUnassign,
}: {
  project: Project
  departments: Department[]
  agents: Member[]
  byHandle: (handle: string) => Member | undefined
  deskOf: (member: Member | undefined) => DeskInfo | undefined
  onAssign: (kind: AssignKind, handle: string) => void
  onUnassign: (kind: AssignKind, handle: string) => void
}) {
  const assignedDepartments = departments.filter((d) => project.departments.some((h) => sameHandle(h, d.handle)))
  const freeDepartments = departments.filter((d) => !assignedDepartments.includes(d))
  const freeAgents = agents.filter((a) => !project.specialists.some((h) => sameHandle(h, a.handle)))
  const remove = (kind: AssignKind, handle: string, name: string) => (
    <button
      type="button"
      aria-label={`Remove ${name} from ${project.name}`}
      onClick={() => onUnassign(kind, handle)}
      className="min-h-10 shrink-0 rounded px-2 text-[12px] text-muted hover:bg-canvas hover:text-ink md:min-h-7"
    >
      Remove
    </button>
  )

  const leadMember = project.lead ? byHandle(project.lead) : undefined
  return (
    <article aria-label={project.name} className={CARD}>
      <h3 className="flex items-baseline gap-2 text-[14px] font-semibold">
        <Link to="/p/$handle" params={{ handle: project.handle }} className="hover:underline">
          {project.name}
        </Link>
        <span className="font-mono text-[11px] font-normal text-faint">@{project.handle}</span>
        <Link to="/p/$handle" params={{ handle: project.handle }} className="ml-auto text-[12px] font-normal text-accent hover:underline">
          Open
        </Link>
      </h3>
      <p className="flex flex-wrap items-center gap-1 pt-1 text-[12px] text-muted">
        {project.channels.length > 0 ? (
          project.channels.map((name) => (
            <span key={name} className={CHIP}>
              #{name}
            </span>
          ))
        ) : (
          <span>No channels listed</span>
        )}
        {project.repo_path && <span className="font-mono text-[11px] text-faint">{project.repo_path.split(/[\\/]+/).filter(Boolean).pop()}</span>}
      </p>

      {project.lead ? (
        <ul className="divide-y divide-line">
          <AgentRow handle={project.lead} member={leadMember} desk={deskOf(leadMember)} badge="Project lead" />
        </ul>
      ) : (
        <p className="py-1 text-[12px] text-muted">No lead: @{project.handle} reaches nobody yet.</p>
      )}

      <p className={cx("pt-3", SECTION_LABEL)}>Departments</p>
      {assignedDepartments.length === 0 ? (
        <p className="py-1 text-[12px] text-muted">None assigned.</p>
      ) : (
        <ul className="divide-y divide-line">
          {assignedDepartments.map((department) => (
            <li key={department.handle} className="flex min-h-10 items-center gap-2 py-1 text-[13px]">
              <span className="min-w-0 flex-1 truncate">
                <span className="font-medium">{department.display_name}</span>{" "}
                <span className="text-[12px] text-muted">{departmentHandles(department).length} agents</span>
              </span>
              {remove("department", department.handle, department.display_name)}
            </li>
          ))}
        </ul>
      )}

      <p className={cx("pt-3", SECTION_LABEL)}>Specialists</p>
      {project.specialists.length === 0 ? (
        <p className="py-1 text-[12px] text-muted">None assigned.</p>
      ) : (
        <ul className="divide-y divide-line">
          {project.specialists.map((handle) => {
            const member = byHandle(handle)
            return (
              <AgentRow
                key={handle}
                handle={handle}
                member={member}
                desk={deskOf(member)}
                action={remove("specialist", handle, member?.display_name ?? handle)}
              />
            )
          })}
        </ul>
      )}

      <select
        aria-label={`Assign to ${project.name}`}
        value=""
        onChange={(event) => {
          const [kind, handle] = event.target.value.split(":")
          if ((kind === "department" || kind === "specialist") && handle) onAssign(kind, handle)
        }}
        disabled={freeDepartments.length === 0 && freeAgents.length === 0}
        className="mt-2 min-h-10 w-full rounded border border-line bg-surface px-2 text-[13px] md:min-h-8"
      >
        <option value="">Assign...</option>
        {freeDepartments.length > 0 && (
          <optgroup label="Departments">
            {freeDepartments.map((department) => (
              <option key={department.handle} value={`department:${department.handle}`}>
                {department.display_name}
              </option>
            ))}
          </optgroup>
        )}
        {freeAgents.length > 0 && (
          <optgroup label="Specialists">
            {freeAgents.map((agent) => (
              <option key={agent.id} value={`specialist:${agent.handle}`}>
                {agent.display_name}
              </option>
            ))}
          </optgroup>
        )}
      </select>
    </article>
  )
}

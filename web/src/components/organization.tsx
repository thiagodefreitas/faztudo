import { useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { useState, type ReactNode } from "react"
import { api } from "../api/client"
import { cx } from "../lib/cx"
import { qk } from "../state/keys"
import { useNow } from "../state/now"
import { useApprovals, useLanes, useMe, useMembers, useOrg, useRuns } from "../state/queries"
import type { AssignKind, Department, Member, Project } from "../types"
import { AgentAvatar } from "./agent-avatar"
import { avatarState } from "./office/avatar"
import { deriveMemberDesk, type DeskInfo, type DeskState } from "./office/state"
import { CreateProjectDialog } from "./project-dialogs"

const CARD = "rounded-lg border border-line bg-surface p-3"
const CHIP = "inline-flex items-center rounded-full bg-sidebar px-2 py-0.5 text-[11px] text-muted"
const PRIMARY = "inline-flex min-h-8 items-center rounded-md bg-accent px-2.5 text-[12px] font-medium text-canvas hover:opacity-90"

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
  return (
    <li className="flex min-h-10 items-center gap-2 py-1" data-agent={handle}>
      {member ? (
        <AgentAvatar member={member} size={28} state={desk ? avatarState(desk.state) : undefined} decorative />
      ) : (
        <span className="inline-block h-7 w-7 rounded-md bg-sidebar" aria-hidden="true" />
      )}
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-[13px]">
          <span className="truncate font-medium">{member?.display_name ?? handle}</span>
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
      {action}
    </li>
  )
}

export function OrganizationPage() {
  const me = useMe()
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

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex items-baseline gap-3 border-b border-line px-3 py-2">
        <Link to="/" className="min-h-10 py-2 text-[13px] text-muted md:hidden">
          Inbox
        </Link>
        <h1 className="text-[15px] font-semibold">Organization</h1>
        <p className="font-mono text-[12px] text-muted">
          {departments.length} departments, {projects.length} projects
        </p>
        <Link to="/routines" className="ml-auto min-h-10 py-2 text-[13px] text-accent hover:underline md:min-h-0 md:py-0">
          Routines
        </Link>
        <button type="button" onClick={() => setCreating(true)} className={PRIMARY}>
          New project
        </button>
      </header>
      <CreateProjectDialog open={creating} onOpenChange={setCreating} onCreated={(project) => void navigate({ to: "/p/$handle", params: { handle: project.handle } })} />
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-3">
        {error && (
          <p role="alert" className="text-[13px] text-danger">
            {error}
          </p>
        )}
        {org.isPending ? (
          <p className="text-[13px] text-muted">Loading organization</p>
        ) : (
          <>
            {director && (
              <div className="flex items-center gap-3" data-testid="director">
                <AgentAvatar member={director} size={36} decorative />
                <div>
                  <p className="text-[14px] font-medium">{director.display_name}</p>
                  <p className="text-[12px] text-muted">Director. Assigns teams to projects and answers judgment calls.</p>
                </div>
              </div>
            )}

            {chiefs.length > 0 && (
              <div data-testid="chief-of-staff">
                <h2 className="pb-1 text-[11px] font-medium uppercase tracking-wide text-faint">Chief of Staff</h2>
                <p className="pb-1 text-[12px] text-muted">
                  Gets messages that are not addressed to anyone, in channels that opted in, and hands them to the right agent in a thread.
                </p>
                <ul className="divide-y divide-line">
                  {chiefs.map((chief) => (
                    <AgentRow key={chief.id} handle={chief.handle} member={chief} desk={deskOf(chief)} badge="Chief of Staff" />
                  ))}
                </ul>
              </div>
            )}

            <div>
              <h2 className="pb-2 text-[11px] font-medium uppercase tracking-wide text-faint">Departments</h2>
              {departments.length === 0 ? (
                <p className="text-[13px] text-muted">
                  No departments yet. Add <code className="font-mono">[[department]]</code> entries to lanes.toml.
                </p>
              ) : (
                <div className="grid items-start gap-3 lg:grid-cols-2 2xl:grid-cols-3">
                  {departments.map((department) => {
                    const worksOn = projects.filter((project) => project.departments.some((h) => sameHandle(h, department.handle)))
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
              <h2 className="flex items-baseline gap-2 pb-2 text-[11px] font-medium uppercase tracking-wide text-faint">
                Projects
                <button type="button" onClick={() => setCreating(true)} className="ml-auto text-[12px] font-medium normal-case tracking-normal text-accent hover:underline">
                  New project
                </button>
              </h2>
              {projects.length === 0 ? (
                <p className="rounded-lg border border-dashed border-line px-3 py-2.5 text-[13px] text-muted">
                  No projects yet. Create one here or add <code className="font-mono">[[project]]</code> entries to lanes.toml.
                </p>
              ) : (
                <div className="grid items-start gap-3 lg:grid-cols-2 2xl:grid-cols-3">
                  {projects.map((project) => (
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

      <p className="pt-2 text-[11px] font-medium uppercase tracking-wide text-faint">Departments</p>
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

      <p className="pt-2 text-[11px] font-medium uppercase tracking-wide text-faint">Specialists</p>
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

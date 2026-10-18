import * as Dialog from "@radix-ui/react-dialog"
import { useQueryClient } from "@tanstack/react-query"
import { useState, type FormEvent, type ReactNode } from "react"
import { ApiError, api } from "../api/client"
import { cx } from "../lib/cx"
import { handleFromName, teamOf } from "../lib/projects"
import { qk } from "../state/keys"
import { replaceById } from "../state/merge"
import type { Channel, Member, Org, Project } from "../types"
import { AgentAvatar } from "./agent-avatar"
import { CHANNEL_NAME_RE, Field, Shell, errorText, inputClass } from "./channel-dialogs"

const HANDLE_RE = /^[a-z0-9][a-z0-9_-]*$/i

const CHIP = "flex min-h-8 cursor-pointer items-center gap-1.5 rounded-md border px-1.5 text-[12px] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent"
const CHIP_ON = "border-accent bg-accent-soft text-ink"
const CHIP_OFF = "border-line text-muted hover:bg-canvas"

// A row of toggles, each one a checkbox behind a face and a name, so the
// keyboard reaches every member with Tab and Space.
export function MemberChips({
  label,
  members,
  selected,
  onToggle,
  locked,
}: {
  label: string
  members: Member[]
  selected: Set<string>
  onToggle: (id: string) => void
  locked?: Set<string>
}) {
  if (members.length === 0) return null
  return (
    <fieldset className="mt-3">
      <legend className="text-[13px] font-medium">{label}</legend>
      <ul className="mt-1 flex flex-wrap gap-1.5">
        {members.map((member) => {
          const on = selected.has(member.id)
          const fixed = locked?.has(member.id) ?? false
          return (
            <li key={member.id}>
              <label className={cx(CHIP, on ? CHIP_ON : CHIP_OFF, fixed && "cursor-default")}>
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={on}
                  disabled={fixed}
                  onChange={() => onToggle(member.id)}
                  aria-label={member.display_name}
                />
                <AgentAvatar member={member} size={20} decorative />
                <span>{member.display_name}</span>
                {member.agent?.role && <span className="hidden text-[11px] text-faint sm:inline">{member.agent.role}</span>}
              </label>
            </li>
          )
        })}
      </ul>
    </fieldset>
  )
}

function toggleIn(set: Set<string>, id: string): Set<string> {
  const next = new Set(set)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

function Summary({ children }: { children: ReactNode }) {
  return <p className="mt-3 rounded-md bg-sidebar px-2 py-1.5 text-[12px] text-muted">{children}</p>
}

export function CreateProjectDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (project: Project) => void
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      {open && <ProjectForm onCreated={onCreated} onDone={() => onOpenChange(false)} />}
    </Dialog.Root>
  )
}

// A project takes a name, a handle, a repository, a lead, the departments and
// specialists that work on it, and its first channels. The channels are
// created right away with the Director and the team as members and the lead
// as the default agent.
function ProjectForm({ onCreated, onDone }: { onCreated: (project: Project) => void; onDone: () => void }) {
  const qc = useQueryClient()
  const org = qc.getQueryData<Org>(qk.org)
  const me = qc.getQueryData<Member>(qk.me)
  const members = qc.getQueryData<Member[]>(qk.members) ?? []
  const agents = members.filter((member) => member.kind === "agent")
  const departments = org?.departments ?? []
  const [name, setName] = useState("")
  const [handle, setHandle] = useState("")
  const [handleEdited, setHandleEdited] = useState(false)
  const [repoPath, setRepoPath] = useState("")
  const [lead, setLead] = useState("")
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [chosenDepartments, setChosenDepartments] = useState<Set<string>>(new Set())
  const [channels, setChannels] = useState("")
  const [channelsEdited, setChannelsEdited] = useState(false)
  const [busy, setBusy] = useState(false)
  const [nameError, setNameError] = useState<string | null>(null)
  const [handleError, setHandleError] = useState<string | null>(null)
  const [repoError, setRepoError] = useState<string | null>(null)
  const [channelsError, setChannelsError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)

  const channelNames = (channelsEdited ? channels : handle ? `${handle}-dev` : "")
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean)

  function changeName(value: string) {
    setName(value)
    if (!handleEdited) setHandle(handleFromName(value))
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    setNameError(null)
    setHandleError(null)
    setRepoError(null)
    setChannelsError(null)
    setFormError(null)
    const trimmedName = name.trim()
    if (!trimmedName) {
      setNameError("Give the project a name.")
      return
    }
    if (!HANDLE_RE.test(handle)) {
      setHandleError("Use letters, digits, - and _, for example launch-week.")
      return
    }
    const bad = channelNames.find((item) => !CHANNEL_NAME_RE.test(item))
    if (bad) {
      setChannelsError(`${bad}: use lowercase letters, digits and dashes.`)
      return
    }
    setBusy(true)
    const specialists = agents.filter((agent) => picked.has(agent.id)).map((agent) => agent.handle)
    void (async () => {
      let project: Project
      try {
        project = await api.createProject({
          handle,
          name: trimmedName,
          ...(repoPath.trim() ? { repo_path: repoPath.trim() } : {}),
          ...(lead ? { lead } : {}),
          channels: channelNames,
          departments: [...chosenDepartments],
          specialists,
        })
      } catch (error) {
        setBusy(false)
        const message = errorText(error)
        if (error instanceof ApiError && /repo_path|git|repo/i.test(message)) setRepoError(message)
        else if (error instanceof ApiError && /handle|exists/i.test(message)) setHandleError(message)
        else if (error instanceof ApiError && /channel/i.test(message)) setChannelsError(message)
        else setFormError(message)
        return
      }
      await qc.invalidateQueries({ queryKey: qk.org })
      const nextOrg: Org = org ? { ...org, projects: [...org.projects, project] } : { director_id: me?.id ?? "", departments: [], projects: [project] }
      const team = teamOf(project, nextOrg, members).map((item) => item.member)
      const leadMember = agents.find((agent) => agent.handle.toLowerCase() === lead.toLowerCase())
      const memberIds = [...new Set([...(me ? [me.id] : []), ...team.map((member) => member.id)])]
      const existing = new Set((qc.getQueryData<Channel[]>(qk.channels) ?? []).map((channel) => channel.name.toLowerCase()))
      const problems: string[] = []
      for (const channelName of channelNames) {
        if (existing.has(channelName.toLowerCase())) continue
        try {
          const channel = await api.createChannel({
            name: channelName,
            kind: "project",
            visibility: "public",
            topic: `${trimmedName} team channel`,
            ...(project.repo_path ? { repo_path: project.repo_path } : {}),
            member_ids: memberIds,
          })
          const withDefault = leadMember && memberIds.includes(leadMember.id) ? await api.patchChannel(channel.id, { default_agent_id: leadMember.id }) : channel
          qc.setQueryData<Channel[]>(qk.channels, (list = []) => replaceById(list, withDefault))
        } catch (error) {
          problems.push(`#${channelName}: ${errorText(error)}`)
        }
      }
      setBusy(false)
      if (problems.length > 0) {
        setFormError(`The project exists, but a channel was not created. ${problems.join(" ")}`)
        return
      }
      onDone()
      onCreated(project)
    })()
  }

  const teamSize = [...chosenDepartments].reduce((sum, item) => {
    const department = departments.find((candidate) => candidate.handle === item)
    if (!department) return sum
    const handles = new Set([...(department.lead ? [department.lead] : []), ...department.members])
    return sum + handles.size
  }, 0)

  return (
    <Shell
      title="New project"
      description="A project groups channels and a repository. Only the team you pick acts in its channels."
      onSubmit={submit}
      submitLabel="Create project"
      busy={busy}
      formError={formError}
    >
      <Field label="Name" error={nameError}>
        {({ id, describedBy }) => (
          <input
            id={id}
            aria-describedby={describedBy || undefined}
            aria-invalid={nameError ? true : undefined}
            value={name}
            onChange={(event) => changeName(event.target.value)}
            className={inputClass}
            placeholder="Launch week"
            autoComplete="off"
            autoFocus
          />
        )}
      </Field>
      <Field label="Handle" help="@handle in a message goes to the project lead." error={handleError}>
        {({ id, describedBy }) => (
          <input
            id={id}
            aria-describedby={describedBy || undefined}
            aria-invalid={handleError ? true : undefined}
            value={handle}
            onChange={(event) => {
              setHandleEdited(true)
              setHandle(event.target.value)
            }}
            className={`${inputClass} font-mono`}
            placeholder="launch-week"
            autoComplete="off"
          />
        )}
      </Field>
      <Field label="Repository folder (optional)" help="Local git work tree the project's channels work on." error={repoError}>
        {({ id, describedBy }) => (
          <input
            id={id}
            aria-describedby={describedBy || undefined}
            aria-invalid={repoError ? true : undefined}
            value={repoPath}
            onChange={(event) => setRepoPath(event.target.value)}
            className={`${inputClass} font-mono`}
            placeholder="/home/you/code/project"
          />
        )}
      </Field>
      <Field label="Lead" help="Splits a request to the project across the team and answers for it.">
        {({ id, describedBy }) => (
          <select id={id} aria-describedby={describedBy || undefined} value={lead} onChange={(event) => setLead(event.target.value)} className={inputClass}>
            <option value="">None yet</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.handle}>
                {agent.display_name}
                {agent.agent?.role ? `, ${agent.agent.role}` : ""}
              </option>
            ))}
          </select>
        )}
      </Field>
      {departments.length > 0 && (
        <fieldset className="mt-3">
          <legend className="text-[13px] font-medium">Departments</legend>
          <ul className="mt-1 flex flex-wrap gap-1.5">
            {departments.map((department) => {
              const on = chosenDepartments.has(department.handle)
              const size = new Set([...(department.lead ? [department.lead] : []), ...department.members]).size
              return (
                <li key={department.handle}>
                  <label className={cx(CHIP, on ? CHIP_ON : CHIP_OFF)}>
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={on}
                      onChange={() => setChosenDepartments((prev) => toggleIn(prev, department.handle))}
                      aria-label={department.display_name}
                    />
                    <span className="font-medium">{department.display_name}</span>
                    <span className="font-mono text-[11px] text-faint">{size}</span>
                  </label>
                </li>
              )
            })}
          </ul>
        </fieldset>
      )}
      <MemberChips label="Specialists" members={agents} selected={picked} onToggle={(id) => setPicked((prev) => toggleIn(prev, id))} />
      <Field label="First channels" help="Names separated by spaces or commas. Created now, with you and the team as members." error={channelsError}>
        {({ id, describedBy }) => (
          <input
            id={id}
            aria-describedby={describedBy || undefined}
            aria-invalid={channelsError ? true : undefined}
            value={channelsEdited ? channels : channelNames.join(" ")}
            onChange={(event) => {
              setChannelsEdited(true)
              setChannels(event.target.value)
            }}
            className={`${inputClass} font-mono`}
            placeholder="launch-dev launch-release"
            autoComplete="off"
          />
        )}
      </Field>
      <Summary>
        {teamSize + picked.size === 0 && !lead
          ? "Nobody is on the team yet. Agents outside the team get a notice instead of running here."
          : `${teamSize + picked.size + (lead ? 1 : 0)} on the team${lead ? `, led by @${lead}` : ""}. ${channelNames.length} ${channelNames.length === 1 ? "channel" : "channels"} to create.`}
      </Summary>
    </Shell>
  )
}

export function CreateTeamChannelDialog({
  project,
  initialName = "",
  open,
  onOpenChange,
  onCreated,
}: {
  project: Project
  /** A channel the project lists but nobody created yet. */
  initialName?: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (channel: Channel) => void
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      {open && <TeamChannelForm project={project} initialName={initialName} onCreated={onCreated} onDone={() => onOpenChange(false)} />}
    </Dialog.Root>
  )
}

// A team channel inside a project: a name, a topic, the people and agents in
// it, and which agent answers plain messages. It is listed under the project
// as soon as it exists.
function TeamChannelForm({
  project,
  initialName,
  onCreated,
  onDone,
}: {
  project: Project
  initialName: string
  onCreated: (channel: Channel) => void
  onDone: () => void
}) {
  const qc = useQueryClient()
  const org = qc.getQueryData<Org>(qk.org)
  const me = qc.getQueryData<Member>(qk.me)
  const members = qc.getQueryData<Member[]>(qk.members) ?? []
  const humans = members.filter((member) => member.kind === "human")
  const agents = members.filter((member) => member.kind === "agent")
  const team = org ? teamOf(project, org, members) : []
  const locked = new Set(me ? [me.id] : [])
  const [name, setName] = useState(initialName)
  const [topic, setTopic] = useState("")
  const [picked, setPicked] = useState<Set<string>>(new Set([...locked, ...team.map((item) => item.member.id)]))
  const [defaultAgent, setDefaultAgent] = useState(() => {
    const lead = team.find((item) => item.role === "Lead")
    return lead?.member.id ?? ""
  })
  const [busy, setBusy] = useState(false)
  const [nameError, setNameError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)

  const pickedAgents = agents.filter((agent) => picked.has(agent.id))
  const effectiveDefault = picked.has(defaultAgent) ? defaultAgent : ""

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    const trimmed = name.trim()
    setNameError(null)
    setFormError(null)
    if (!CHANNEL_NAME_RE.test(trimmed)) {
      setNameError("Use lowercase letters, digits and dashes, for example launch-design.")
      return
    }
    setBusy(true)
    void (async () => {
      try {
        const created = await api.createChannel({
          name: trimmed,
          kind: "project",
          visibility: "public",
          ...(topic.trim() ? { topic: topic.trim() } : {}),
          ...(project.repo_path ? { repo_path: project.repo_path } : {}),
          member_ids: [...picked],
        })
        const channel = effectiveDefault ? await api.patchChannel(created.id, { default_agent_id: effectiveDefault }) : created
        qc.setQueryData<Channel[]>(qk.channels, (list = []) => replaceById(list, channel))
        if (!project.channels.some((item) => item.toLowerCase() === trimmed.toLowerCase())) {
          await api.patchProject(project.handle, { channels: [...project.channels, trimmed] })
          await qc.invalidateQueries({ queryKey: qk.org })
        }
        setBusy(false)
        onDone()
        onCreated(channel)
      } catch (error) {
        setBusy(false)
        const message = errorText(error)
        if (error instanceof ApiError && /name/i.test(message)) setNameError(message)
        else setFormError(message)
      }
    })()
  }

  return (
    <Shell
      title={`New channel in ${project.name}`}
      description="A team channel for part of the project's work. Only agents assigned to the project run in it."
      onSubmit={submit}
      submitLabel="Create channel"
      busy={busy}
      formError={formError}
    >
      <Field label="Name" help="Lowercase letters, digits and dashes." error={nameError}>
        {({ id, describedBy }) => (
          <input
            id={id}
            aria-describedby={describedBy || undefined}
            aria-invalid={nameError ? true : undefined}
            value={name}
            onChange={(event) => setName(event.target.value)}
            className={`${inputClass} font-mono`}
            placeholder={`${project.handle}-design`}
            autoComplete="off"
            autoFocus
          />
        )}
      </Field>
      <Field label="Topic" help="Short line shown under the channel name.">
        {({ id, describedBy }) => (
          <input id={id} aria-describedby={describedBy || undefined} value={topic} onChange={(event) => setTopic(event.target.value)} className={inputClass} />
        )}
      </Field>
      <MemberChips label="People" members={humans} selected={picked} onToggle={(id) => setPicked((prev) => toggleIn(prev, id))} locked={locked} />
      <MemberChips label="Agents" members={agents} selected={picked} onToggle={(id) => setPicked((prev) => toggleIn(prev, id))} />
      <Field label="Default agent" help="Answers plain messages that mention nobody.">
        {({ id, describedBy }) => (
          <select
            id={id}
            aria-describedby={describedBy || undefined}
            value={effectiveDefault}
            onChange={(event) => setDefaultAgent(event.target.value)}
            className={inputClass}
            disabled={pickedAgents.length === 0}
          >
            <option value="">None</option>
            {pickedAgents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.display_name}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Summary>
        {picked.size} {picked.size === 1 ? "member" : "members"}
        {pickedAgents.length > 0 ? `, ${pickedAgents.length} ${pickedAgents.length === 1 ? "agent" : "agents"}` : ""}.
        {project.repo_path ? ` Write runs work in ${project.repo_path.split(/[\\/]+/).filter(Boolean).pop() ?? project.repo_path}.` : " No repository: read runs only."}
      </Summary>
    </Shell>
  )
}

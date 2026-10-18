import { useQueryClient } from "@tanstack/react-query"
import { Link, getRouteApi } from "@tanstack/react-router"
import { useState, type FormEvent } from "react"
import { api } from "../../api/client"
import { channelsOfProject } from "../../lib/projects"
import { qk } from "../../state/keys"
import { useChannels, useMembers, useOrg } from "../../state/queries"
import type { Channel, Member, Project } from "../../types"

const routeApi = getRouteApi("/projects/$handle/settings")
const input = "min-h-10 w-full rounded-md border border-line bg-surface px-2.5 text-[13px] text-ink focus:outline-2 focus:outline-accent"
const button = "min-h-9 rounded-md bg-accent px-3 text-[13px] font-medium text-canvas disabled:opacity-50"

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Could not save changes."
}

export function ProjectSettingsPage() {
  const { handle } = routeApi.useParams()
  const org = useOrg()
  const channels = useChannels()
  const members = useMembers()
  const qc = useQueryClient()
  const project = org.data?.projects.find((item) => item.handle.toLowerCase() === handle.toLowerCase())
  if (org.isPending || channels.isPending || members.isPending) return <p className="p-4 text-[13px] text-muted">Loading project settings</p>
  if (!project) return <p className="p-4 text-[13px] text-muted">Project not found.</p>

  const claimed = new Set((org.data?.projects ?? []).filter((item) => item.handle !== project.handle).flatMap((item) => item.channels.map((name) => name.toLowerCase())))
  const available = (channels.data ?? []).filter((channel) => channel.kind !== "direct" && (!claimed.has(channel.name.toLowerCase()) || project.channels.some((name) => name.toLowerCase() === channel.name.toLowerCase())))
  const mine = channelsOfProject(project, channels.data ?? [])
  return (
    <section className="min-h-0 flex-1 overflow-y-auto p-3" aria-label="Project settings">
      <div className="mx-auto max-w-2xl space-y-5">
        <header className="flex items-center justify-between gap-3">
          <div><h1 className="text-[17px] font-semibold">{project.name} settings</h1><p className="text-[12px] text-muted">@{project.handle}</p></div>
          <Link to="/p/$handle" params={{ handle: project.handle }} className="text-[13px] text-accent hover:underline">Project home</Link>
        </header>
        <ProjectFields key={project.handle} project={project} available={available} members={members.data ?? []} onSaved={() => void qc.invalidateQueries({ queryKey: qk.org })} />
        <section aria-label="Channel settings" className="space-y-3">
          <h2 className="text-[14px] font-semibold">Channel settings</h2>
          {mine.length === 0 && <p className="text-[13px] text-muted">Add an existing channel above, or create one from the project home.</p>}
          {mine.map((channel) => <ChannelFields key={channel.id} channel={channel} members={members.data ?? []} onSaved={() => void qc.invalidateQueries({ queryKey: qk.channels })} />)}
        </section>
      </div>
    </section>
  )
}

function ProjectFields({ project, available, members, onSaved }: { project: Project; available: Channel[]; members: Member[]; onSaved: () => void }) {
  const [name, setName] = useState(project.name)
  const [repoPath, setRepoPath] = useState(project.repo_path ?? "")
  const [lead, setLead] = useState(project.lead ?? "")
  const [picked, setPicked] = useState(project.channels)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [saved, setSaved] = useState(false)
  const agents = members.filter((member) => member.kind === "agent")
  const missing = project.channels.filter((channel) => !available.some((item) => item.name.toLowerCase() === channel.toLowerCase()))
  const nameError = /name/i.test(error) ? error : ""
  const repoError = /repo|git/i.test(error) ? error : ""
  const leadError = /lead/i.test(error) ? error : ""
  const channelsError = /channel/i.test(error) ? error : ""
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError("")
    setSaved(false)
    if (!name.trim()) { setError("Name is required."); return }
    setBusy(true)
    try {
      await api.patchProject(project.handle, { name: name.trim(), repo_path: repoPath.trim(), lead, channels: picked })
      onSaved()
      setSaved(true)
    } catch (cause) { setError(message(cause)) }
    finally { setBusy(false) }
  }
  async function archive() {
    setError("")
    setBusy(true)
    try {
      await api.patchProject(project.handle, { archived: !project.archived })
      onSaved()
    } catch (cause) { setError(message(cause)) }
    finally { setBusy(false) }
  }
  return (
    <form onSubmit={(event) => void save(event)} className="space-y-3 rounded-lg border border-line bg-surface p-3">
      <label className="block text-[13px] font-medium">Name<input className={`${input} mt-1`} value={name} aria-invalid={!!nameError} onChange={(event) => setName(event.target.value)} />{nameError && <span role="alert" className="block text-[12px] text-danger">{nameError}</span>}</label>
      <label className="block text-[13px] font-medium">Repository folder<input className={`${input} mt-1 font-mono`} value={repoPath} aria-invalid={!!repoError} onChange={(event) => setRepoPath(event.target.value)} placeholder="/home/you/code/project" />{repoError && <span role="alert" className="block text-[12px] text-danger">{repoError}</span>}</label>
      <p className="text-[12px] text-muted">The folder must be a git work tree. Existing channels keep their own repository setting.</p>
      <label className="block text-[13px] font-medium">Lead<select className={`${input} mt-1`} value={lead} aria-invalid={!!leadError} onChange={(event) => setLead(event.target.value)}><option value="">No lead</option>{agents.map((agent) => <option key={agent.id} value={agent.handle}>{agent.display_name}</option>)}</select>{leadError && <span role="alert" className="block text-[12px] text-danger">{leadError}</span>}</label>
      <fieldset><legend className="text-[13px] font-medium">Channels</legend><div className="mt-1 grid gap-1 sm:grid-cols-2">{available.map((channel) => <label key={channel.id} className="flex min-h-9 items-center gap-2 text-[13px]"><input type="checkbox" checked={picked.some((name) => name.toLowerCase() === channel.name.toLowerCase())} onChange={(event) => setPicked((previous) => event.target.checked ? [...previous, channel.name] : previous.filter((name) => name.toLowerCase() !== channel.name.toLowerCase()))} />#{channel.name}</label>)}{missing.map((name) => <label key={name} className="flex min-h-9 items-center gap-2 text-[13px] text-warn"><input type="checkbox" checked={picked.some((item) => item.toLowerCase() === name.toLowerCase())} onChange={(event) => setPicked((previous) => event.target.checked ? [...previous, name] : previous.filter((item) => item.toLowerCase() !== name.toLowerCase()))} />#{name} (not created)</label>)}</div></fieldset>
      {channelsError && <p role="alert" className="text-[12px] text-danger">{channelsError}</p>}
      {error && !nameError && !repoError && !leadError && !channelsError && <p role="alert" className="text-[12px] text-danger">{error}</p>}
      {saved && <p role="status" className="text-[12px] text-ok">Project saved.</p>}
      <div className="flex items-center justify-between gap-3"><button type="submit" disabled={busy} className={button}>Save project</button><button type="button" disabled={busy} onClick={() => void archive()} className="min-h-9 text-[13px] text-muted hover:underline">{project.archived ? "Unarchive project" : "Archive project"}</button></div>
    </form>
  )
}

function ChannelFields({ channel, members, onSaved }: { channel: Channel; members: Member[]; onSaved: () => void }) {
  const [testCommand, setTestCommand] = useState(channel.test_command ?? "")
  const [defaultAgent, setDefaultAgent] = useState(channel.default_agent_id ?? "")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [saved, setSaved] = useState(false)
  const agents = members.filter((member) => member.kind === "agent" && channel.member_ids.includes(member.id))
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError("")
    setSaved(false)
    try {
      await api.patchChannel(channel.id, { test_command: testCommand.trim(), default_agent_id: defaultAgent })
      onSaved()
      setSaved(true)
    } catch (cause) { setError(message(cause)) }
    finally { setBusy(false) }
  }
  return <form onSubmit={(event) => void save(event)} className="space-y-2 rounded-lg border border-line bg-surface p-3" aria-label={`#${channel.name} settings`}>
    <h3 className="text-[13px] font-medium">#{channel.name}</h3>
    <label className="block text-[13px]">Test command<input className={`${input} mt-1 font-mono`} value={testCommand} onChange={(event) => setTestCommand(event.target.value)} /></label>
    <label className="block text-[13px]">Default agent<select className={`${input} mt-1`} value={defaultAgent} onChange={(event) => setDefaultAgent(event.target.value)}><option value="">None</option>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.display_name}</option>)}</select></label>
    {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
    {saved && <p role="status" className="text-[12px] text-ok">Channel saved.</p>}
    <button type="submit" disabled={busy} className={button}>Save #{channel.name}</button>
  </form>
}

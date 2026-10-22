import * as Dialog from "@radix-ui/react-dialog"
import { useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { api } from "../api/client"
import { cx } from "../lib/cx"
import { isAssigned, projectOfChannel } from "../lib/projects"
import { qk } from "../state/keys"
import { replaceById } from "../state/merge"
import { useNow } from "../state/now"
import { useApprovals, useLanes, useMe, useMembers, useMessages, useOrg, useRuns } from "../state/queries"
import type { ApprovalRule, Channel, Member } from "../types"
import { AgentAvatar } from "./agent-avatar"
import { buttonClass, errorText, inputClass } from "./channel-dialogs"
import { avatarState } from "./office/avatar"
import { deriveMemberDesk, type DeskState } from "./office/state"
import { LessonsButton } from "./lessons/lessons-dialog"
import { TeamIcon } from "./team-icon"
import { HumanAvatar } from "./chat/human-avatar"
import { useProfileNavigation } from "./profile/navigation"

const STATE_CLASS: Record<DeskState, string> = {
  idle: "bg-sidebar text-muted",
  working: "bg-accent-soft text-accent",
  queued: "bg-sidebar text-muted",
  waiting_approval: "bg-warn-soft text-warn",
  failed: "bg-danger-soft text-danger",
  out_of_quota: "bg-sidebar text-faint",
}

const SMALL = "min-h-8 rounded-md px-2 text-[12px] text-muted hover:bg-canvas hover:text-ink disabled:opacity-50 md:min-h-7"

// The people and agents in a channel, with what each agent is doing, which
// lane it runs on and whether the project lets it act here. The Director
// adds and removes members, assigns an agent to the project and picks the
// agent that answers plain messages.
export function MembersPanel({ channel, open, onOpenChange }: { channel: Channel; open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      {open && <Panel channel={channel} />}
    </Dialog.Root>
  )
}

function Panel({ channel }: { channel: Channel }) {
  const { openProfile } = useProfileNavigation()
  const qc = useQueryClient()
  const me = useMe()
  const members = useMembers()
  const org = useOrg()
  const runs = useRuns()
  const messages = useMessages(channel.id)
  const approvals = useApprovals()
  const lanes = useLanes()
  const now = useNow()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState("")
  const [rules, setRules] = useState<ApprovalRule[]>([])

  const all = members.data ?? []
  const meId = me.data?.id
  const isHuman = me.data?.kind === "human"
  useEffect(() => { if (isHuman) void api.approvalRules(channel.id).then(setRules).catch(() => setRules([])) }, [channel.id, isHuman])
  const project = org.data ? projectOfChannel(channel, org.data.projects) : undefined
  const inside = all.filter((member) => channel.member_ids.includes(member.id))
  const outside = all.filter((member) => !channel.member_ids.includes(member.id))
  const triggerMessages = new Map((messages.data ?? []).map((message) => [message.id, message.body]))
  const deskById = new Map(inside.filter((member) => member.kind === "agent").map((member) => [member.id, deriveMemberDesk({ member, runs: runs.data ?? [], approvals: approvals.data ?? [], lanes: lanes.data ?? [], triggerMessages, now })]))
  const priority: Record<DeskState, number> = { working: 0, waiting_approval: 1, queued: 2, failed: 3, out_of_quota: 4, idle: 5 }
  const sorted = inside.slice().sort((a, b) => {
    const rankA = a.kind === "agent" ? priority[deskById.get(a.id)?.state ?? "idle"] : 6
    const rankB = b.kind === "agent" ? priority[deskById.get(b.id)?.state ?? "idle"] : 6
    return rankA - rankB || Number(b.id === channel.default_agent_id) - Number(a.id === channel.default_agent_id) || a.display_name.localeCompare(b.display_name)
  })
  const agentsInside = inside.filter((member) => member.kind === "agent").length

  async function change(work: () => Promise<unknown>) {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await work()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  function patchMembers(ids: string[], defaultAgent?: string) {
    return change(async () => {
      const next = await api.patchChannel(channel.id, { member_ids: ids, ...(defaultAgent !== undefined ? { default_agent_id: defaultAgent } : {}) })
      qc.setQueryData<Channel[]>(qk.channels, (list = []) => replaceById(list, next))
    })
  }

  function assign(member: Member) {
    if (!project) return
    return change(async () => {
      await api.assign(project.handle, { kind: "specialist", handle: member.handle })
      await qc.invalidateQueries({ queryKey: qk.org })
    })
  }

  return (
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/40" />
      <Dialog.Content
        aria-describedby={undefined}
        className="fixed inset-y-0 right-0 z-50 flex w-[min(24rem,100vw)] flex-col border-l border-line bg-surface shadow-lg max-md:inset-x-0 max-md:w-auto"
      >
        <header className="flex items-center gap-2 border-b border-line px-3 py-2">
          <TeamIcon channel={channel} members={all} excludeId={meId} size={28} layout="cluster" />
          <div className="min-w-0 flex-1">
            <Dialog.Title className="truncate text-[15px] font-semibold">Members of #{channel.name}</Dialog.Title>
            <p className="truncate text-[12px] text-muted">
              {inside.length} {inside.length === 1 ? "member" : "members"}, {agentsInside} {agentsInside === 1 ? "agent" : "agents"}
              {project && (
                <>
                  {" "}
                  in{" "}
                  <Link to="/p/$handle" params={{ handle: project.handle }} className="text-accent hover:underline">
                    {project.name}
                  </Link>
                </>
              )}
            </p>
          </div>
          <Dialog.Close className={buttonClass} aria-label="Close members">
            Close
          </Dialog.Close>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {isHuman && <section className="border-b border-line px-3 py-3" aria-label="Approval rules">
            <h3 className="text-[13px] font-semibold">Approval rules</h3>
            {rules.length === 0 ? <p className="mt-1 text-[12px] text-muted">No automatic merge rules in this channel.</p> : <ul className="mt-2 space-y-2">{rules.map((rule) => <li key={rule.id} className="flex items-start gap-2 text-[12px]"><span className="min-w-0 flex-1 break-words">{rule.persona || "Any agent"}: {rule.paths.join(", ") || "any path"}, up to {rule.max_lines} lines</span><button type="button" className="text-danger hover:underline" onClick={() => void api.deleteApprovalRule(rule.id).then(() => setRules((items) => items.filter((item) => item.id !== rule.id)))}>Remove</button></li>)}</ul>}
          </section>}
          {error && (
            <p role="alert" className="px-3 pt-2 text-[12px] text-danger">
              {error}
            </p>
          )}
          <ul className="divide-y divide-line" aria-label="Members">
            {sorted.map((member) => {
              const desk = deskById.get(member.id)
              const assigned = project && member.kind === "agent" ? isAssigned(project, org.data?.departments ?? [], member.handle) : undefined
              const isDefault = member.id === channel.default_agent_id
              const you = member.id === meId
              const director = member.id === org.data?.director_id
              return (
                <li key={member.id} className="flex items-start gap-2.5 px-3 py-2" data-member={member.id} data-assigned={assigned}>
                  <button type="button" onClick={() => openProfile(member.handle)} aria-label={`Profile: @${member.handle}`} className="mt-0.5 flex shrink-0 rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">{member.kind === "human" ? <HumanAvatar member={member} size={36} /> : <AgentAvatar member={member} size={36} state={desk ? avatarState(desk.state) : undefined} decorative />}</button>
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px]">
                      <button type="button" onClick={() => openProfile(member.handle)} className="rounded font-medium hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">{member.display_name}</button>
                      <span className="font-mono text-[11px] text-faint">@{member.handle}</span>
                      {you && <span className="text-[11px] text-faint">(you)</span>}
                      {isDefault && <span className="rounded bg-accent-soft px-1.5 text-[11px] text-accent">Default</span>}
                      {assigned === false && <span className="rounded bg-warn-soft px-1.5 text-[11px] text-warn">Not assigned</span>}
                    </p>
                    <p className="truncate text-[12px] text-muted">
                      {member.kind === "human" ? (director ? "Director" : "Human") : (member.agent?.role ?? "Agent")}
                    </p>
                    {desk && (
                      <>
                        <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
                          <span className={cx("rounded-full px-2 py-0.5", STATE_CLASS[desk.state])}>{desk.stateLabel}</span>
                          {desk.laneId && <span className="font-mono text-faint">{desk.laneId}</span>}
                          {desk.state === "out_of_quota" && desk.resetTimeText && <span className="text-faint">Back at {desk.resetTimeText}</span>}
                        </p>
                        {(desk.runTitle || desk.currentRun) && <p className="mt-1 truncate text-[12px] text-muted" title={desk.runRequest ?? desk.runTitle}>{desk.runTitle ?? `Run ${desk.currentRun?.id}`}</p>}
                      </>
                    )}
                    {isHuman && (
                      <p className="mt-1 flex flex-wrap gap-1">
                        {assigned === false && project && (
                          <button type="button" disabled={busy} onClick={() => void assign(member)} className={cx(SMALL, "text-accent")}>
                            Assign to {project.name}
                          </button>
                        )}
                        {member.kind === "agent" && !isDefault && (
                          <button type="button" disabled={busy} onClick={() => void patchMembers(channel.member_ids, member.id)} className={SMALL}>
                            Make default
                          </button>
                        )}
                        {member.kind === "agent" && isDefault && (
                          <button type="button" disabled={busy} onClick={() => void patchMembers(channel.member_ids, "")} className={SMALL}>
                            Clear default
                          </button>
                        )}
                        {member.kind === "agent" && <LessonsButton persona={member.handle} className={SMALL} />}
                        {member.kind === "agent" && <Dialog.Close asChild><button type="button" onClick={() => window.dispatchEvent(new CustomEvent("faztudo:compose-mention", { detail: `@${member.handle} ` }))} className={SMALL} title={`Message ${member.display_name}`}>Message</button></Dialog.Close>}
                        {!you && (
                          <button
                            type="button"
                            disabled={busy}
                            aria-label={`Remove ${member.display_name}`}
                            onClick={() =>
                              void patchMembers(
                                channel.member_ids.filter((id) => id !== member.id),
                                isDefault ? "" : undefined,
                              )
                            }
                            className={SMALL}
                          >
                            Remove
                          </button>
                        )}
                      </p>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        </div>
        {isHuman && (
          <footer className="border-t border-line px-3 py-2">
            <label htmlFor="members-add" className="text-[12px] font-medium">
              Add a member
            </label>
            <div className="flex gap-2">
              <select id="members-add" value={adding} onChange={(event) => setAdding(event.target.value)} className={cx(inputClass, "mt-1 flex-1")} disabled={outside.length === 0}>
                <option value="">{outside.length === 0 ? "Everyone is here" : "Choose..."}</option>
                {outside.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.display_name}
                    {member.kind === "agent" ? " (agent)" : ""}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={!adding || busy}
                onClick={() => {
                  const id = adding
                  setAdding("")
                  void patchMembers([...channel.member_ids, id])
                }}
                className="mt-1 min-h-8 rounded-md bg-accent px-3 text-[13px] text-canvas disabled:opacity-60"
              >
                Add
              </button>
            </div>
          </footer>
        )}
      </Dialog.Content>
    </Dialog.Portal>
  )
}

import * as Dialog from "@radix-ui/react-dialog"
import { useQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useRef, useState } from "react"
import { api } from "../../api/client"
import { groupWork, runTime, workColumn, workUsage, WORK_TITLES, type WorkColumn } from "../../lib/all-work"
import { cx } from "../../lib/cx"
import { HEALTH_META } from "../../lib/lane-health"
import { formatCostAbout, formatCountdown } from "../../lib/lane-format"
import { primaryWindow } from "../../lib/lanes"
import { formatElapsed } from "../../lib/time"
import { useOpenDirect } from "../../state/direct"
import { useNow } from "../../state/now"
import { useAllMessages, useApprovals, useChannels, useComputers, useLanes, useLessons, useMe, useMembers, useOrg, useRoutines, useRuns } from "../../state/queries"
import type { Computer, Lane, Member, Run } from "../../types"
import { AgentAvatar } from "../agent-avatar"
import { HumanAvatar } from "../chat/human-avatar"
import { healthDotClass } from "../lane-chip"
import { LessonsDialog } from "../lessons/lessons-dialog"
import { deriveMemberDesk, type DeskState } from "../office/state"
import { PRIMARY_BUTTON, SECONDARY_BUTTON, SECTION_LABEL } from "../page-header"
import { TaskBuilder } from "../tasks/task-builder"
import { profileOpener, useProfileNavigation } from "./navigation"

const SECTION = "border-t border-line px-5 py-4"
const DAY = 24 * 60 * 60 * 1000

const STATE_DOT: Record<DeskState, string> = {
  idle: "bg-faint",
  working: "bg-accent",
  queued: "bg-muted",
  waiting_approval: "bg-warn",
  failed: "bg-danger",
  out_of_quota: "bg-danger",
}

const OUTCOME_TONE: Record<WorkColumn, string> = {
  queued: "text-muted",
  running: "text-accent",
  needs_you: "text-warn",
  done: "text-ok",
  failed: "text-danger",
}

const COMPUTER_STATE: Record<Computer["state"], string> = {
  off: "Off",
  idle: "Idle",
  running: "Running",
  full: "Disk full",
}

function sentence(text: string): string {
  return text ? text[0]!.toUpperCase() + text.slice(1) : text
}

function resetAt(lane: Lane | undefined): string | undefined {
  const stamp = lane ? primaryWindow(lane)?.resets_at : undefined
  return stamp && !Number.isNaN(Date.parse(stamp)) ? stamp : undefined
}

function size(bytes: number): string {
  const mb = bytes / 1048576
  return mb >= 1024 ? `${(mb / 1024).toFixed(mb >= 10240 ? 0 : 1)} GB` : `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`
}

function RunLine({ run, channelName, request, now }: { run: Run; channelName: string; request: string; now: number }) {
  const usage = workUsage(run)
  const column = workColumn(run)
  const meta = [`#${channelName}`, run.lane_id, run.started_at ? formatElapsed(run.started_at, run.ended_at, now) : ""].filter(Boolean)
  return (
    <li className="rounded-lg border border-line bg-canvas px-3 py-2 text-[12px]" data-run={run.id}>
      <div className="flex items-start justify-between gap-3">
        <span className="min-w-0 truncate font-medium" title={request}>{request || `Run ${run.id.slice(0, 8)}`}</span>
        <span className={cx("shrink-0", OUTCOME_TONE[column])}>{run.state === "cancelled" ? "Cancelled" : WORK_TITLES[column]}</span>
      </div>
      <p className="mt-0.5 flex flex-wrap gap-x-2 text-muted">
        {meta.map((item, index) => <span key={index} className={index === 1 ? "font-mono text-[11px]" : undefined}>{item}</span>)}
      </p>
      {usage && <p className="mt-0.5 tabular-nums text-faint">{usage}</p>}
    </li>
  )
}

export function ProfileSheet() {
  const { handle, closeProfile } = useProfileNavigation()
  const members = useMembers()
  const me = useMe()
  const channels = useChannels()
  const runs = useRuns()
  const lanes = useLanes()
  const approvals = useApprovals()
  const org = useOrg()
  const lessons = useLessons()
  const routines = useRoutines()
  const computers = useComputers(me.data?.kind === "human" && Boolean(handle))
  const now = useNow()
  const openDirect = useOpenDirect()
  const navigate = useNavigate()
  const content = useRef<HTMLDivElement>(null)
  const [building, setBuilding] = useState(false)
  const [teaching, setTeaching] = useState(false)
  const [activeAgent, setActiveAgent] = useState<Member | null>(null)
  const [actionError, setActionError] = useState("")
  const member = members.data?.find((item) => item.handle.toLowerCase() === handle?.toLowerCase())
  const isAgent = member?.kind === "agent"
  const allChannels = channels.data ?? []
  const channelName = (id: string) => allChannels.find((channel) => channel.id === id)?.name ?? "a channel"
  const messages = useAllMessages(handle && isAgent ? allChannels.map((channel) => channel.id) : [])
  const triggerMessages = new Map(messages.map((message) => [message.id, message.body]))
  const desk = member && isAgent ? deriveMemberDesk({ member, runs: runs.data ?? [], approvals: approvals.data ?? [], lanes: lanes.data ?? [], triggerMessages, now, members: members.data ?? [] }) : undefined
  const team = org.data?.departments.filter((department) => department.lead === member?.handle || department.members.includes(member?.handle ?? "")) ?? []
  const today = member && isAgent ? groupWork((runs.data ?? []).filter((run) => run.agent_id === member.id), messages, members.data ?? [], now) : undefined
  const todayRuns = today ? Object.values(today).flat().filter(({ run }) => {
    const time = runTime(run)
    return time !== undefined && now - time <= DAY
  }).sort((a, b) => (runTime(b.run) ?? 0) - (runTime(a.run) ?? 0)) : []
  const todayCost = todayRuns.reduce((sum, { run }) => sum + (run.cost_usd ?? 0), 0)
  const runningLane = desk?.currentRun?.lane_id
  // With nothing running, the next run takes the first lane that has room.
  const nextLane = member?.agent?.lanes.find((id) => {
    const lane = lanes.data?.find((item) => item.id === id)
    return lane && lane.health !== "exhausted" && lane.health !== "unavailable"
  })
  // The soonest reset among the agent's lanes is when it can run again.
  const chainResets = (member?.agent?.lanes ?? []).map((id) => resetAt(lanes.data?.find((item) => item.id === id))).filter((stamp): stamp is string => Boolean(stamp)).sort((a, b) => Date.parse(a) - Date.parse(b))
  const lessonCount = (lessons.data ?? []).filter((lesson) => lesson.persona === member?.handle).length
  const usedBy = (routines.data ?? []).filter((routine) => routine.persona === member?.handle)
  const computer = computers.data?.find((item) => item.id.toLowerCase() === member?.handle.toLowerCase())
  const { data: devices } = useQuery({ queryKey: ["profile", "devices"], queryFn: () => api.devices(), enabled: Boolean(handle && member?.id === me.data?.id && member?.kind === "human") })
  const director = member?.id === org.data?.director_id
  const you = member?.id === me.data?.id

  function message(person: Member) {
    closeProfile()
    void openDirect(person).catch((error: unknown) => setActionError(error instanceof Error ? error.message : "Could not open the message."))
  }

  function act(agent: Member, next: "build" | "teach") {
    setActiveAgent(agent)
    closeProfile()
    if (next === "build") setBuilding(true)
    else setTeaching(true)
  }

  return (
    <>
      <Dialog.Root open={Boolean(handle)} onOpenChange={(open) => { if (!open) closeProfile() }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-ink/30" />
          <Dialog.Content
            ref={content}
            tabIndex={-1}
            data-profile={member?.handle}
            // The sheet itself takes focus, so a deep link does not land on Close.
            onOpenAutoFocus={(event) => { event.preventDefault(); content.current?.focus() }}
            onCloseAutoFocus={(event) => { const target = profileOpener(); if (target?.isConnected) { event.preventDefault(); target.focus() } }}
            className="fixed inset-y-0 right-0 z-50 flex h-dvh w-full flex-col overflow-hidden border-line bg-surface text-ink shadow-lg outline-none sm:w-[min(26rem,100vw)] sm:border-l"
          >
            <header className="flex shrink-0 items-center justify-between border-b border-line px-5 py-2.5 max-sm:pt-[max(0.625rem,env(safe-area-inset-top))]">
              <Dialog.Title className="text-[13px] font-medium text-muted">Profile</Dialog.Title>
              <Dialog.Close className="min-h-10 rounded-md px-2 text-[13px] text-muted hover:bg-sidebar hover:text-ink md:min-h-8">Close</Dialog.Close>
            </header>
            <Dialog.Description className="sr-only">{member ? `Who @${member.handle} is and what they are doing` : "Member details"}</Dialog.Description>
            <div className="min-h-0 flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)]">
              {!member ? <p className="px-5 py-6 text-[13px] text-muted">{members.isPending ? "Loading profile..." : `No member found for @${handle}.`}</p> : <>
                <div className="px-5 py-5">
                  <div className="flex items-start gap-3">
                    {isAgent ? <AgentAvatar member={member} size={48} state={desk?.state === "working" ? "working" : desk?.state === "waiting_approval" ? "waiting" : undefined} decorative /> : <HumanAvatar member={member} size={48} />}
                    <div className="min-w-0 flex-1">
                      <h2 className="truncate text-[18px] font-semibold leading-tight">{member.display_name}</h2>
                      <p className="mt-0.5 font-mono text-[12px] text-muted">@{member.handle}{you && <span className="font-sans text-faint"> (you)</span>}</p>
                      <p className="mt-1 text-[13px]">{isAgent ? member.agent?.role || "Agent" : director ? "Director" : "Person"}</p>
                    </div>
                  </div>
                  {isAgent && member.agent?.description && <p className="mt-3 text-[13px] leading-relaxed text-muted">{member.agent.description}</p>}
                  {(team.length > 0 || (!isAgent && devices)) && (
                    <dl className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[12px]">
                      {team.length > 0 && <div className="flex gap-1.5"><dt className="text-faint">Team</dt><dd>{team.map((item) => item.display_name).join(", ")}</dd></div>}
                      {!isAgent && devices && <div className="flex gap-1.5"><dt className="text-faint">Devices</dt><dd className="tabular-nums">{devices.length}</dd></div>}
                    </dl>
                  )}
                  <div className={cx("mt-4 gap-2", isAgent ? "grid grid-cols-2 sm:flex sm:flex-wrap" : "flex")}>
                    {!you && <button type="button" onClick={() => message(member)} className={PRIMARY_BUTTON}>Message</button>}
                    {isAgent && <>
                      <button type="button" onClick={() => act(member, "build")} className={SECONDARY_BUTTON}>New task</button>
                      <button type="button" onClick={() => act(member, "teach")} className={SECONDARY_BUTTON}>Teach</button>
                      <button type="button" onClick={() => { closeProfile(); void navigate({ to: "/lanes", search: { lane: runningLane ?? nextLane ?? member.agent?.lanes[0] } }) }} className={SECONDARY_BUTTON}>Open on Lanes</button>
                    </>}
                  </div>
                  {actionError && <p role="alert" className="mt-2 text-[12px] text-danger">{actionError}</p>}
                </div>
                {isAgent && desk && <>
                  <section className={SECTION} aria-label="Live state">
                    <h3 className={SECTION_LABEL}>Now</h3>
                    <p className="mt-2 flex items-center gap-2 text-[13px] font-medium" data-state={desk.state}>
                      <span className={cx("h-2 w-2 shrink-0 rounded-full", STATE_DOT[desk.state], desk.state === "working" && "motion-safe:animate-pulse")} aria-hidden="true" />
                      {sentence(desk.stateLabel)}
                      {desk.currentRun?.started_at && <span className="ml-auto font-normal tabular-nums text-muted">{formatElapsed(desk.currentRun.started_at, undefined, now)}</span>}
                    </p>
                    {desk.currentRun && <p className="mt-1 line-clamp-2 text-[13px] text-muted" title={desk.runRequest}>{desk.runTitle ?? desk.runRequest ?? "Current run"} <span className="text-faint">in #{channelName(desk.currentRun.channel_id)}</span></p>}
                    {desk.state === "waiting_approval" && <p className="mt-1 text-[12px] text-warn">Waiting for you to review</p>}
                    {desk.state === "out_of_quota" && <p className="mt-1 text-[12px] text-muted">{chainResets[0] ? `Quota ${formatCountdown(chainResets[0], now)}` : "Every lane in the chain is out of quota"}</p>}
                  </section>
                  <section className={SECTION} aria-label="Lane chain">
                    <h3 className={SECTION_LABEL}>Lane chain</h3>
                    <ol className="mt-2 space-y-1.5">{(member.agent?.lanes ?? []).map((id, index) => {
                      const lane = lanes.data?.find((item) => item.id === id)
                      const health = lane?.health ?? "unknown"
                      const reset = health === "exhausted" && resetAt(lane) ? formatCountdown(resetAt(lane), now) : undefined
                      const tag = id === runningLane ? "Running" : !runningLane && id === nextLane ? "Next" : undefined
                      return (
                        <li key={id} className="flex items-center gap-2 text-[12px]" data-lane={id}>
                          <span className="w-3 shrink-0 text-right tabular-nums text-faint">{index + 1}</span>
                          <span className={cx("h-2 w-2 shrink-0 rounded-full", healthDotClass(health))} aria-hidden="true" />
                          <span className="min-w-0 flex-1 truncate font-mono">{id}</span>
                          <span className="text-muted">{reset ? `${HEALTH_META[health].label}, ${reset}` : HEALTH_META[health].label}</span>
                          {tag && <span className={cx("rounded px-1.5", tag === "Running" ? "bg-accent-soft text-accent" : "bg-sidebar text-muted")}>{tag}</span>}
                        </li>
                      )
                    })}</ol>
                  </section>
                  <section className={SECTION} aria-label="Today's runs">
                    <h3 className={cx(SECTION_LABEL, "flex justify-between")}>
                      <span>Today's runs ({todayRuns.length})</span>
                      {todayCost > 0 && <span className="normal-case tracking-normal tabular-nums">{formatCostAbout(todayCost)}</span>}
                    </h3>
                    {todayRuns.length ? <ul className="mt-2 space-y-2">{todayRuns.map(({ run, request }) => <RunLine key={run.id} run={run} request={request} channelName={channelName(run.channel_id)} now={now} />)}</ul> : <p className="mt-2 text-[12px] text-muted">No runs in the last 24 hours.</p>}
                  </section>
                  <section className={SECTION} aria-label="Lessons and routines">
                    <h3 className={SECTION_LABEL}>Lessons and routines</h3>
                    <button type="button" onClick={() => act(member, "teach")} className="mt-2 rounded text-[13px] font-medium text-accent hover:underline">
                      {lessonCount === 1 ? "1 lesson" : `${lessonCount} lessons`}
                    </button>
                    <p className="mt-3 text-[12px] text-faint">Routines using @{member.handle}</p>
                    {usedBy.length ? <ul className="mt-1 space-y-1 text-[13px]">{usedBy.map((routine) => <li key={routine.handle}>{routine.name}{!routine.enabled && <span className="text-faint"> (off)</span>}</li>)}</ul> : <p className="mt-1 text-[13px] text-muted">None</p>}
                  </section>
                  {computer && (
                    <section className={SECTION} aria-label="Agent computer">
                      <h3 className={SECTION_LABEL}>Agent computer</h3>
                      <p className="mt-2 text-[13px]">{COMPUTER_STATE[computer.state]}<span className="text-muted">, {size(computer.disk_bytes)}{computer.disk_soft_max > 0 ? ` of ${size(computer.disk_soft_max)}` : ""} used</span></p>
                    </section>
                  )}
                </>}
              </>}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      {activeAgent?.kind === "agent" && building && <TaskBuilder open onOpenChange={setBuilding} channels={allChannels.filter((channel) => channel.kind !== "direct")} initialAssignee={activeAgent.handle} />}
      {activeAgent?.kind === "agent" && teaching && <LessonsDialog persona={activeAgent.handle} open onOpenChange={setTeaching} />}
    </>
  )
}

import * as Tooltip from "@radix-ui/react-tooltip"
import { Link, useNavigate, useRouterState } from "@tanstack/react-router"
import { useState } from "react"
import { identityOf } from "../lib/avatar"
import { cx } from "../lib/cx"
import { directPeer, findDirect, isDirect } from "../lib/direct"
import { primaryWindow } from "../lib/lanes"
import { groupChannels, pendingApprovals, projectCounts } from "../lib/projects"
import { useTheme } from "../lib/theme"
import { formatAge } from "../lib/time"
import { useNow } from "../state/now"
import { useOpenDirect } from "../state/direct"
import { useApprovals, useChannels, useLanes, useMe, useMembers, useOrg, useRuns } from "../state/queries"
import { useStreamStatus } from "../state/status"
import type { Approval, Channel, Lane, LaneHealth, Member, Presence, Project, Run } from "../types"
import { WORKSPACE_NAME } from "../types"
import { CreateChannelDialog } from "./channel-dialogs"
import { CreateProjectDialog } from "./project-dialogs"
import { TeamIcon } from "./team-icon"
import { healthDotClass } from "./lane-chip"
import { AgentAvatar, type AvatarState } from "./agent-avatar"
import { laneBorrower } from "./office/state"
import { LanesGauge } from "./lanes"

const PRESENCE: Record<Presence, string> = {
  online: "bg-ok",
  idle: "bg-warn",
  busy: "bg-accent",
  offline: "bg-faint",
}

// An agent with no run is "offline", which is its normal resting state, so
// it stays in color; the lane dot next to it says whether it can run.
const AGENT_STATE: Record<Presence, AvatarState | undefined> = {
  online: undefined,
  idle: undefined,
  busy: "working",
  offline: undefined,
}

const STATUS_LABEL = {
  open: "Live",
  connecting: "Connecting",
  closed: "Offline",
} as const

const ROW = "flex min-h-10 items-center gap-2 rounded-md px-2 text-[13px] transition-colors duration-150 md:min-h-7"
// The open row is tinted and bold; a row with unread messages is bold too.
const ACTIVE_ROW = "bg-accent-soft font-medium text-ink"
const IDLE_ROW = "text-ink hover:bg-canvas"
const HEADING = "px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-faint"
const PLUS = "inline-flex h-10 w-10 items-center justify-center rounded text-[16px] text-muted hover:bg-canvas md:h-7 md:w-7"
const BADGE = "min-w-5 rounded-full px-1.5 text-center text-[11px] font-medium leading-[18px] tabular-nums text-canvas"

const COLLAPSED_KEY = "faztudo-rail-collapsed"

// Which projects the rail shows folded. Kept per browser; a wiped store
// means every project is open.
function readCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY)
    const list: unknown = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : [])
  } catch {
    return new Set()
  }
}

function writeCollapsed(set: Set<string>) {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...set]))
  } catch {
    // Private mode or a full store: the fold is forgotten on reload.
  }
}

export function Sidebar() {
  return (
    <aside className="hidden w-64 shrink-0 flex-col border-r border-line bg-sidebar md:flex">
      <WorkspaceNav />
    </aside>
  )
}

export function WorkspaceNav({ onNavigate }: { onNavigate?: () => void }) {
  const channels = useChannels()
  const members = useMembers()
  const lanes = useLanes()
  const runs = useRuns()
  const org = useOrg()
  const approvals = useApprovals()
  const me = useMe()
  const openDirect = useOpenDirect()
  const now = useNow()
  const status = useStreamStatus()
  const theme = useTheme()
  const navigate = useNavigate()
  const [creating, setCreating] = useState(false)
  const [creatingProject, setCreatingProject] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsed)
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const meId = me.data?.id
  const all = channels.data ?? []
  const rooms = all.filter((channel) => !isDirect(channel))
  const grouped = groupChannels(rooms, org.data?.projects ?? [])
  const waiting = pendingApprovals(approvals.data ?? [])
  const others = (members.data ?? []).filter((member) => member.id !== meId)
  const people = others.filter((member) => member.kind === "human")
  const agents = others.filter((member) => member.kind === "agent")
  // A DM whose peer is no longer a member still deserves a row.
  const orphans = all.filter((channel) => isDirect(channel) && !directPeer(channel, meId, members.data ?? []))
  function startDirect(member: Member) {
    onNavigate?.()
    void openDirect(member)
  }
  function directOf(member: Member): Channel | undefined {
    return meId ? findDirect(all, meId, member.id) : undefined
  }
  function toggleProject(handle: string) {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(handle)) next.delete(handle)
      else next.add(handle)
      writeCollapsed(next)
      return next
    })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Link to="/" onClick={onNavigate} className="px-3 py-3 text-[14px] font-semibold tracking-tight" aria-label={`${WORKSPACE_NAME}, all chats`}>
        {WORKSPACE_NAME}
      </Link>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {waiting.length > 0 && (
          <Link
            to="/approvals"
            onClick={onNavigate}
            className={cx(ROW, "mb-2 justify-between bg-warn-soft font-medium text-warn")}
          >
            <span>Needs you</span>
            <span className={cx(BADGE, "bg-warn")} aria-label={`${waiting.length} waiting`}>
              {waiting.length}
            </span>
          </Link>
        )}
        {org.data && (
          <div className="flex items-center justify-between pb-1 pl-2">
            <p className="text-[11px] font-medium uppercase tracking-wide text-faint">Projects</p>
            <button type="button" aria-label="New project" title="New project" onClick={() => setCreatingProject(true)} className={PLUS}>
              +
            </button>
          </div>
        )}
        <CreateProjectDialog
          open={creatingProject}
          onOpenChange={setCreatingProject}
          onCreated={(project) => {
            onNavigate?.()
            void navigate({ to: "/p/$handle", params: { handle: project.handle } })
          }}
        />
        {grouped.groups.filter(({ project }) => !project.archived).map(({ project, channels }) => (
          <ProjectGroup
            key={project.handle}
            project={project}
            channels={channels}
            approvals={approvals.data ?? []}
            members={members.data ?? []}
            meId={meId}
            pathname={pathname}
            collapsed={collapsed.has(project.handle)}
            onToggle={() => toggleProject(project.handle)}
            onNavigate={onNavigate}
          />
        ))}
        <div className="flex items-center justify-between pb-1 pl-2">
          <p className="text-[11px] font-medium uppercase tracking-wide text-faint">Channels</p>
          <button type="button" aria-label="Create channel" title="Create channel" onClick={() => setCreating(true)} className={PLUS}>
            +
          </button>
        </div>
        <CreateChannelDialog
          open={creating}
          onOpenChange={setCreating}
          onCreated={(channel) => {
            onNavigate?.()
            void navigate({ to: "/c/$channelId", params: { channelId: channel.id } })
          }}
        />
        <ul className="flex flex-col gap-px">
          {grouped.rest.map((channel) => (
            <ChannelRow key={channel.id} channel={channel} pathname={pathname} onNavigate={onNavigate} members={members.data ?? []} meId={meId} />
          ))}
        </ul>
        {(people.length > 0 || orphans.length > 0) && (
          <div className="mt-4">
            <p className={HEADING}>Direct messages</p>
            <ul className="flex flex-col gap-px">
              {people.map((member) => (
                <PeerRow
                  key={member.id}
                  member={member}
                  channel={directOf(member)}
                  pathname={pathname}
                  lanes={[]}
                  now={now}
                  members={[]}
                  runs={[]}
                  onNavigate={onNavigate}
                  onOpen={startDirect}
                />
              ))}
              {orphans.map((channel) => (
                <li key={channel.id}>
                  <Link
                    to="/c/$channelId"
                    params={{ channelId: channel.id }}
                    onClick={onNavigate}
                    aria-current={pathname === `/c/${channel.id}` ? "page" : undefined}
                    className={cx(ROW, pathname === `/c/${channel.id}` ? ACTIVE_ROW : IDLE_ROW, channel.unread > 0 && "font-medium")}
                  >
                    <span className={cx("h-2 w-2 shrink-0 rounded-full", PRESENCE.offline)} aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate">{channel.name}</span>
                    <Unread count={channel.unread} />
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
        {agents.length > 0 && (
          <div className="mt-4">
            <p className={HEADING}>Agents</p>
            <ul className="flex flex-col gap-px">
              {agents.map((member) => (
                <PeerRow
                  key={member.id}
                  member={member}
                  channel={directOf(member)}
                  pathname={pathname}
                  lanes={lanes.data ?? []}
                  now={now}
                  members={members.data ?? []}
                  runs={runs.data ?? []}
                  onNavigate={onNavigate}
                  onOpen={startDirect}
                />
              ))}
            </ul>
          </div>
        )}
      </div>
      <div className="border-t border-line px-2 py-2">
        <LanesGauge lanes={lanes.data ?? []} />
        <Link
          to="/tasks"
          onClick={onNavigate}
          aria-current={pathname.endsWith("/tasks") ? "page" : undefined}
          className={cx(ROW, pathname.endsWith("/tasks") ? ACTIVE_ROW : IDLE_ROW)}
        >
          Tasks
        </Link>
        <Link
          to="/organization"
          onClick={onNavigate}
          aria-current={pathname === "/organization" ? "page" : undefined}
          className={cx(ROW, pathname === "/organization" ? ACTIVE_ROW : IDLE_ROW)}
        >
          Organization
        </Link>
        <Link
          to="/office"
          onClick={onNavigate}
          aria-current={pathname === "/office" ? "page" : undefined}
          className={cx(ROW, "justify-between", pathname === "/office" ? ACTIVE_ROW : IDLE_ROW)}
        >
          <span>Office</span>
          <span className="font-mono text-[11px] text-faint">2D</span>
        </Link>
        <Link
          to="/settings/devices"
          onClick={onNavigate}
          aria-current={pathname === "/settings/devices" ? "page" : undefined}
          className={cx(ROW, "justify-between", pathname === "/settings/devices" ? ACTIVE_ROW : IDLE_ROW)}
        >
          <span>Devices</span>
          <span className="font-mono text-[11px] text-faint">LAN</span>
        </Link>
        <div className="mt-1 flex items-center justify-between gap-2 px-2">
          <p className="text-[12px] text-muted" role="status">
            {STATUS_LABEL[status]}
          </p>
          <button
            type="button"
            onClick={theme.toggle}
            className="min-h-10 rounded px-2 text-[12px] text-ink hover:bg-canvas md:min-h-7"
          >
            {theme.choice === "dark" ? "Use light theme" : "Use dark theme"}
          </button>
        </div>
      </div>
    </div>
  )
}

// A project folds to one row that keeps its counts: unread messages and
// approvals waiting for the Director in its channels.
function ProjectGroup({
  project,
  channels,
  approvals,
  members,
  meId,
  pathname,
  collapsed,
  onToggle,
  onNavigate,
}: {
  project: Project
  channels: Channel[]
  approvals: Approval[]
  members: Member[]
  meId: string | undefined
  pathname: string
  collapsed: boolean
  onToggle: () => void
  onNavigate: (() => void) | undefined
}) {
  const counts = projectCounts(channels, approvals)
  const active = pathname === `/p/${project.handle}`
  const listId = `project-${project.handle}-channels`
  return (
    <div className="mb-2" data-project={project.handle}>
      <div className={cx(ROW, "gap-1 pl-0 pr-1", active ? ACTIVE_ROW : IDLE_ROW)}>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          aria-controls={listId}
          aria-label={`${collapsed ? "Expand" : "Collapse"} ${project.name}`}
          className="inline-flex h-10 w-8 shrink-0 items-center justify-center rounded text-faint hover:text-ink md:h-7 md:w-6"
        >
          <svg viewBox="0 0 12 12" className={cx("h-3 w-3 transition-transform duration-100 motion-reduce:transition-none", collapsed && "-rotate-90")} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="m3 4.5 3 3 3-3" />
          </svg>
        </button>
        <Link
          to="/p/$handle"
          params={{ handle: project.handle }}
          onClick={onNavigate}
          aria-current={active ? "page" : undefined}
          className="flex min-h-10 min-w-0 flex-1 items-center gap-2 font-medium text-ink md:min-h-7"
        >
          <span className="min-w-0 flex-1 truncate">{project.name}</span>
          {counts.waiting > 0 && (
            <span className={cx(BADGE, "bg-warn")} aria-label={`${counts.waiting} waiting for you`}>
              {counts.waiting}
            </span>
          )}
          {collapsed && <Unread count={counts.unread} />}
        </Link>
      </div>
      {!collapsed && (
        <ul id={listId} className="flex flex-col gap-px pl-3">
          {channels.map((channel) => (
            <ChannelRow key={channel.id} channel={channel} pathname={pathname} onNavigate={onNavigate} members={members} meId={meId} />
          ))}
        </ul>
      )}
    </div>
  )
}

function ChannelRow({
  channel,
  pathname,
  onNavigate,
  members,
  meId,
}: {
  channel: Channel
  pathname: string
  onNavigate: (() => void) | undefined
  members: Member[]
  meId: string | undefined
}) {
  const active = pathname === `/c/${channel.id}`
  // A channel with a team shows its faces; a channel with nobody else, a #.
  const team = channel.member_ids.filter((id) => id !== meId).length > 0
  return (
    <li>
      <Link
        to="/c/$channelId"
        params={{ channelId: channel.id }}
        onClick={onNavigate}
        aria-current={active ? "page" : undefined}
        className={cx(ROW, active ? ACTIVE_ROW : IDLE_ROW, channel.unread > 0 && "font-medium")}
      >
        {team ? (
          <TeamIcon channel={channel} members={members} excludeId={meId} size={20} layout="cluster" className="shrink-0" />
        ) : (
          <span className="inline-flex w-5 justify-center text-faint">#</span>
        )}
        <span className="min-w-0 flex-1 truncate">{channel.name}</span>
        <Unread count={channel.unread} />
      </Link>
    </li>
  )
}

function Unread({ count }: { count: number }) {
  if (count <= 0) return null
  return (
    <span className={cx(BADGE, "bg-accent")} aria-label={`${count} unread`}>
      {count}
    </span>
  )
}

// One row per member. It links to the DM when there is one and opens it on
// click otherwise, so a member is never listed twice.
function PeerRow({
  member,
  channel,
  pathname,
  lanes,
  now,
  members,
  runs,
  onNavigate,
  onOpen,
}: {
  member: Member
  channel: Channel | undefined
  pathname: string
  lanes: Lane[]
  now: number
  members: Member[]
  runs: Run[]
  onNavigate: (() => void) | undefined
  onOpen: (member: Member) => void
}) {
  const lane = lanes.find((item) => item.id === member.agent?.lanes[0])
  // A quiet "busy for @persona" only when the CLI is not busy itself.
  const busyFor = member.presence === "busy" ? null : laneBorrower(member, runs, members)
  const active = channel ? pathname === `/c/${channel.id}` : false
  const className = cx(ROW, "min-w-0 flex-1 text-left", active ? ACTIVE_ROW : IDLE_ROW, (channel?.unread ?? 0) > 0 && "font-medium")
  const inner = (
    <>
      {member.kind === "agent" ? (
        busyFor ? (
          <span
            title={`Busy for @${busyFor.handle}`}
            data-busy-for={busyFor.handle}
            className="flex shrink-0 rounded-full"
            style={{
              boxShadow: `0 0 0 1.5px color-mix(in srgb, var(--color-agent-${(identityOf(member).slot % 6) + 1}) 35%, transparent)`,
            }}
          >
            <AgentAvatar member={member} size={20} decorative />
          </span>
        ) : (
          <AgentAvatar member={member} size={20} state={AGENT_STATE[member.presence]} decorative />
        )
      ) : (
        <span className={cx("h-2 w-2 shrink-0 rounded-full", PRESENCE[member.presence])} aria-label={member.presence} />
      )}
      <span className="min-w-0 flex-1 truncate">{member.display_name}</span>
      {channel && <Unread count={channel.unread} />}
    </>
  )
  return (
    <li className="flex items-center gap-1" data-member={member.id}>
      {channel ? (
        <Link to="/c/$channelId" params={{ channelId: channel.id }} onClick={onNavigate} aria-current={active ? "page" : undefined} className={className}>
          {inner}
        </Link>
      ) : (
        <button type="button" onClick={() => onOpen(member)} title={`Message ${member.display_name}`} className={className}>
          {inner}
        </button>
      )}
      {member.kind === "agent" && <LaneDot lane={lane} now={now} />}
    </li>
  )
}

function LaneDot({ lane, now }: { lane: Lane | undefined; now: number }) {
  const health: LaneHealth = lane?.health ?? "unknown"
  const window = lane ? primaryWindow(lane) : undefined
  const age = formatAge(window?.measured_at, now)
  const label = lane ? `${lane.id} ${health}` : "lane unknown"
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center" aria-label={label}>
          <span className={cx("h-2 w-2 rounded-full", healthDotClass(health))} />
        </span>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          sideOffset={6}
          className="z-50 max-w-56 rounded-md border border-line bg-surface px-2 py-1 text-[12px] text-ink shadow-lg"
        >
          <p>{label}</p>
          {lane?.health_reason && <p>{lane.health_reason}</p>}
          <p className="text-muted">
            {window?.source ?? "unknown"}, {age}
          </p>
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  )
}

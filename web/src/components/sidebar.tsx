import * as Tooltip from "@radix-ui/react-tooltip"
import { Link, useNavigate, useRouterState } from "@tanstack/react-router"
import { useState } from "react"
import { cx } from "../lib/cx"
import { directPeer, findDirect, isDirect } from "../lib/direct"
import { primaryWindow } from "../lib/lanes"
import { useTheme } from "../lib/theme"
import { formatAge } from "../lib/time"
import { useNow } from "../state/now"
import { useOpenDirect } from "../state/direct"
import { useChannels, useLanes, useMe, useMembers } from "../state/queries"
import { useStreamStatus } from "../state/status"
import type { Channel, Lane, LaneHealth, Member, Presence } from "../types"
import { WORKSPACE_NAME } from "../types"
import { CreateChannelDialog } from "./channel-dialogs"
import { healthDotClass } from "./lane-chip"
import { LanesGauge } from "./lanes"

const PRESENCE: Record<Presence, string> = {
  online: "bg-ok",
  idle: "bg-warn",
  busy: "bg-accent",
  offline: "bg-faint",
}

const STATUS_LABEL = {
  open: "Live",
  connecting: "Connecting",
  closed: "Offline",
} as const

const ROW = "flex min-h-10 items-center gap-2 rounded-md px-2 text-[13px] md:min-h-7"
const HEADING = "px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-faint"

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
  const me = useMe()
  const openDirect = useOpenDirect()
  const now = useNow()
  const status = useStreamStatus()
  const theme = useTheme()
  const navigate = useNavigate()
  const [creating, setCreating] = useState(false)
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const meId = me.data?.id
  const all = channels.data ?? []
  const rooms = all.filter((channel) => !isDirect(channel))
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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <p className="px-3 py-3 text-[14px] font-semibold tracking-tight">{WORKSPACE_NAME}</p>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        <div className="flex items-center justify-between pb-1 pl-2">
          <p className="text-[11px] font-medium uppercase tracking-wide text-faint">Channels</p>
          <button
            type="button"
            aria-label="Create channel"
            title="Create channel"
            onClick={() => setCreating(true)}
            className="inline-flex h-10 w-10 items-center justify-center rounded text-[16px] text-muted hover:bg-canvas md:h-7 md:w-7"
          >
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
          {rooms.map((channel) => {
            const active = pathname === `/c/${channel.id}`
            return (
              <li key={channel.id}>
                <Link
                  to="/c/$channelId"
                  params={{ channelId: channel.id }}
                  onClick={onNavigate}
                  className={cx(ROW, active ? "bg-accent-soft text-ink" : "text-ink hover:bg-canvas")}
                >
                  <span className="text-faint">#</span>
                  <span className="min-w-0 flex-1 truncate">{channel.name}</span>
                  <Unread count={channel.unread} />
                </Link>
              </li>
            )
          })}
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
                    className={cx(ROW, pathname === `/c/${channel.id}` ? "bg-accent-soft" : "hover:bg-canvas")}
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
        <Link to="/settings/devices" onClick={onNavigate} className={cx(ROW, "justify-between text-ink hover:bg-canvas")}>
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

function Unread({ count }: { count: number }) {
  if (count <= 0) return null
  return (
    <span className="rounded-full bg-accent px-1.5 text-[11px] font-medium text-canvas" aria-label={`${count} unread`}>
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
  onNavigate,
  onOpen,
}: {
  member: Member
  channel: Channel | undefined
  pathname: string
  lanes: Lane[]
  now: number
  onNavigate: (() => void) | undefined
  onOpen: (member: Member) => void
}) {
  const lane = lanes.find((item) => item.id === member.agent?.lanes[0])
  const active = channel ? pathname === `/c/${channel.id}` : false
  const className = cx(ROW, "min-w-0 flex-1 text-left", active ? "bg-accent-soft text-ink" : "text-ink hover:bg-canvas")
  const inner = (
    <>
      <span className={cx("h-2 w-2 shrink-0 rounded-full", PRESENCE[member.presence])} aria-label={member.presence} />
      <span className="min-w-0 flex-1 truncate">{member.display_name}</span>
      {channel && <Unread count={channel.unread} />}
    </>
  )
  return (
    <li className="flex items-center gap-1" data-member={member.id}>
      {channel ? (
        <Link to="/c/$channelId" params={{ channelId: channel.id }} onClick={onNavigate} className={className}>
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

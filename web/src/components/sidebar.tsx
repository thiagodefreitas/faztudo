import * as Tooltip from "@radix-ui/react-tooltip"
import { Link, useNavigate, useRouterState } from "@tanstack/react-router"
import { useState } from "react"
import { cx } from "../lib/cx"
import { primaryWindow } from "../lib/lanes"
import { useTheme } from "../lib/theme"
import { formatAge } from "../lib/time"
import { useNow } from "../state/now"
import { useChannels, useLanes, useMembers } from "../state/queries"
import { useStreamStatus } from "../state/status"
import type { Lane, LaneHealth, Member, Presence } from "../types"
import { WORKSPACE_NAME } from "../types"
import { CreateChannelDialog } from "./channel-dialogs"
import { healthDotClass } from "./lane-chip"

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
  const now = useNow()
  const status = useStreamStatus()
  const theme = useTheme()
  const navigate = useNavigate()
  const [creating, setCreating] = useState(false)
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const people = (members.data ?? []).filter((member) => member.kind === "human")
  const agents = (members.data ?? []).filter((member) => member.kind === "agent")

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
            className="inline-flex h-8 w-8 items-center justify-center rounded text-[16px] text-muted hover:bg-canvas"
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
        <ul className="flex flex-col gap-0.5">
          {(channels.data ?? []).map((channel) => {
            const active = pathname === `/c/${channel.id}`
            return (
              <li key={channel.id}>
                <Link
                  to="/c/$channelId"
                  params={{ channelId: channel.id }}
                  onClick={onNavigate}
                  className={cx(
                    "flex min-h-8 items-center gap-2 rounded px-2 text-[13px]",
                    active ? "bg-accent-soft text-ink" : "text-ink hover:bg-canvas",
                  )}
                >
                  <span className="text-faint">#</span>
                  <span className="min-w-0 flex-1 truncate">{channel.name}</span>
                  {channel.unread > 0 && (
                    <span className="rounded-full bg-accent px-1.5 text-[11px] text-canvas">{channel.unread}</span>
                  )}
                </Link>
              </li>
            )
          })}
        </ul>
        <MemberList title="Agents" members={agents} lanes={lanes.data ?? []} now={now} />
        <MemberList title="People" members={people} lanes={lanes.data ?? []} now={now} />
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-line px-3 py-2">
        <p className="text-[12px] text-muted" role="status">
          {STATUS_LABEL[status]}
        </p>
        <button type="button" onClick={theme.toggle} className="min-h-8 rounded px-2 text-[12px] text-ink hover:bg-canvas">
          {theme.choice === "dark" ? "Use light theme" : "Use dark theme"}
        </button>
      </div>
    </div>
  )
}

function MemberList({
  title,
  members,
  lanes,
  now,
}: {
  title: string
  members: Member[]
  lanes: Lane[]
  now: number
}) {
  if (!members || members.length === 0) return null
  return (
    <div className="mt-4">
      <p className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-faint">{title}</p>
      <ul className="flex flex-col gap-0.5">
        {members.map((member) => {
          const laneId = member.agent?.lanes[0]
          const lane = lanes.find((item) => item.id === laneId)
          return (
            <li key={member.id} className="flex min-h-8 items-center gap-2 px-2 text-[13px]">
              <span className={cx("h-2 w-2 shrink-0 rounded-full", PRESENCE[member.presence])} aria-label={member.presence} />
              <span className="min-w-0 flex-1 truncate">{member.display_name}</span>
              {member.kind === "agent" && <LaneDot lane={lane} now={now} />}
            </li>
          )
        })}
      </ul>
    </div>
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
        <span className="inline-flex h-4 w-4 items-center justify-center" aria-label={label}>
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

import { useNavigate, useRouterState } from "@tanstack/react-router"
import { Command } from "cmdk"
import { useEffect, useState, type ReactNode } from "react"
import { cx } from "../lib/cx"
import { isDirect } from "../lib/direct"
import { useTheme } from "../lib/theme"
import { useOpenDirect } from "../state/direct"
import { laneGauge } from "../lib/lane-gauge"
import { useNow } from "../state/now"
import { useChannels, useLanes, useMe, useMembers } from "../state/queries"
import { healthDotClass } from "./lane-chip"
import { AgentAvatar } from "./agent-avatar"
import { CreateChannelDialog } from "./channel-dialogs"
import { OPEN_SEARCH_EVENT } from "./search-dialog"

// The channel page listens for this to open its settings dialog.
export const OPEN_SETTINGS_EVENT = "faztudo:open-settings"
// The inbox search button asks the palette to open.
export const OPEN_PALETTE_EVENT = "faztudo:open-palette"

const itemClass =
  "flex min-h-9 cursor-default items-center gap-2 rounded px-2 text-[13px] text-ink aria-selected:bg-accent-soft"
const headingClass =
  "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-faint"

export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const navigate = useNavigate()
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const channels = useChannels()
  const members = useMembers()
  const me = useMe()
  const theme = useTheme()
  const openDirect = useOpenDirect()
  const lanes = useLanes()
  const now = useNow()
  const inChannel = pathname.startsWith("/c/")

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "k") {
        event.preventDefault()
        setOpen((value) => !value)
      }
    }
    function onOpen() {
      setOpen(true)
    }
    window.addEventListener("keydown", onKey)
    window.addEventListener(OPEN_PALETTE_EVENT, onOpen)
    return () => {
      window.removeEventListener("keydown", onKey)
      window.removeEventListener(OPEN_PALETTE_EVENT, onOpen)
    }
  }, [])

  function run(action: () => void) {
    setOpen(false)
    action()
  }

  const rooms = (channels.data ?? []).filter((channel) => !isDirect(channel))
  const others = (members.data ?? []).filter((member) => member.id !== me.data?.id)

  return (
    <>
      <Command.Dialog
        open={open}
        onOpenChange={setOpen}
        label="Command palette"
        overlayClassName="fixed inset-0 z-40 bg-ink/40"
        contentClassName="fixed left-1/2 top-[15vh] z-50 w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-lg border border-line bg-surface shadow-lg"
      >
        <Command.Input
          placeholder="Type a command or search"
          aria-label="Search commands"
          className="min-h-11 w-full border-b border-line bg-surface px-3 text-[16px] text-ink outline-none md:text-[14px]"
        />
        <Command.List className="max-h-80 overflow-y-auto p-1">
          <Command.Empty className="px-3 py-4 text-[13px] text-muted">No matching command.</Command.Empty>
          <Group heading="Channels">
            {rooms.map((channel) => (
              <Command.Item
                key={channel.id}
                value={`channel ${channel.name}`}
                className={itemClass}
                onSelect={() =>
                  run(() => void navigate({ to: "/c/$channelId", params: { channelId: channel.id } }))
                }
              >
                <span className="text-faint">#</span>
                {channel.name}
              </Command.Item>
            ))}
          </Group>
          <Group heading="Direct messages">
            {others.map((member) => (
              <Command.Item
                key={member.id}
                value={`message ${member.display_name} ${member.handle}`}
                className={itemClass}
                onSelect={() => run(() => void openDirect(member))}
              >
                <AgentAvatar member={member} size={20} decorative />
                Message {member.display_name}
              </Command.Item>
            ))}
          </Group>
          <Group heading="Lanes">
            {(lanes.data ?? []).map((lane) => {
              const gauge = laneGauge(lane, now)
              return (
                <Command.Item
                  key={lane.id}
                  value={`lane ${lane.id} ${lane.health}`}
                  className={itemClass}
                  onSelect={() => run(() => void navigate({ to: "/lanes", search: gauge.href }))}
                >
                  <span className={cx("h-1.5 w-1.5 shrink-0 rounded-full", healthDotClass(gauge.health))} aria-hidden />
                  <span className="font-mono">{gauge.id}</span>
                  <span className="ml-auto font-mono text-[12px] tabular-nums text-muted" title={gauge.tooltip.join("\n")}>
                    {gauge.text}
                  </span>
                </Command.Item>
              )
            })}
          </Group>
          <Group heading="Actions">
            <Command.Item
              value="search messages"
              className={itemClass}
              onSelect={() => run(() => window.dispatchEvent(new Event(OPEN_SEARCH_EVENT)))}
            >
              Search messages
            </Command.Item>
            <Command.Item
              value="open lanes page"
              className={itemClass}
              onSelect={() => run(() => void navigate({ to: "/lanes" }))}
            >
              Open Lanes
            </Command.Item>
            <Command.Item value="create channel" className={itemClass} onSelect={() => run(() => setCreating(true))}>
              Create channel
            </Command.Item>
            <Command.Item value="toggle theme" className={itemClass} onSelect={() => run(theme.toggle)}>
              {theme.choice === "dark" ? "Use light theme" : "Use dark theme"}
            </Command.Item>
            {inChannel && (
              <Command.Item
                value="open channel settings"
                className={itemClass}
                onSelect={() => run(() => window.dispatchEvent(new Event(OPEN_SETTINGS_EVENT)))}
              >
                Open channel settings
              </Command.Item>
            )}
          </Group>
        </Command.List>
      </Command.Dialog>
      <CreateChannelDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(channel) => void navigate({ to: "/c/$channelId", params: { channelId: channel.id } })}
      />
    </>
  )
}

function Group({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <Command.Group heading={heading} className={headingClass}>
      {children}
    </Command.Group>
  )
}

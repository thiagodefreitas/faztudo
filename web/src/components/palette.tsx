import * as Dialog from "@radix-ui/react-dialog"
import { useNavigate, useRouterState } from "@tanstack/react-router"
import { Command, defaultFilter } from "cmdk"
import { useEffect, useRef, useState, type ReactNode } from "react"
import { cx } from "../lib/cx"
import { isDirect } from "../lib/direct"
import { laneGauge } from "../lib/lane-gauge"
import { useTheme } from "../lib/theme"
import { writeOpen } from "../lib/today"
import { useOpenDirect } from "../state/direct"
import { useNow } from "../state/now"
import { useChannels, useLanes, useMe, useMembers } from "../state/queries"
import { AgentAvatar } from "./agent-avatar"
import { CreateChannelDialog } from "./channel-dialogs"
import { healthDotClass } from "./lane-chip"
import { Kbd } from "./page-header"
import { OPEN_SEARCH_EVENT } from "./search-dialog"
import { TaskBuilder } from "./tasks/task-builder"
import { OPEN_TODAY_EVENT } from "./today-brief"
import { useProfileNavigation } from "./profile/navigation"

// The channel page listens for this to open its settings dialog.
export const OPEN_SETTINGS_EVENT = "faztudo:open-settings"
// The inbox search button asks the palette to open.
export const OPEN_PALETTE_EVENT = "faztudo:open-palette"
// Anything can ask for the keyboard shortcuts sheet.
export const OPEN_SHORTCUTS_EVENT = "faztudo:open-shortcuts"

const RECENT_KEY = "faztudo.palette.recent"
const RECENT_MAX = 5

const itemClass =
  "flex min-h-10 cursor-default items-center gap-2.5 rounded-md px-2 text-[13px] text-ink transition-colors duration-100 aria-selected:bg-accent-soft md:min-h-9"
const headingClass =
  "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-faint"

function isMac(): boolean {
  if (typeof navigator === "undefined") return false
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
}

// The modifier key name for this platform, for shortcut hints.
function modKey(): string {
  return isMac() ? "Cmd" : "Ctrl"
}

function readRecent(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]")
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string").slice(0, RECENT_MAX) : []
  } catch {
    return []
  }
}

function writeRecent(list: string[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list))
  } catch {
    // Recent items last until the page closes only.
  }
}

function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable
}

type GroupName = "Go to" | "Channels" | "Agents" | "People" | "Lanes" | "Actions"
const GROUPS: GroupName[] = ["Go to", "Channels", "Agents", "People", "Lanes", "Actions"]

interface Entry {
  /** Stable id, kept in the recent list. */
  id: string
  group: GroupName
  /** What cmdk matches the typed text against. */
  value: string
  icon?: ReactNode
  label: ReactNode
  hint?: ReactNode
  run: () => void
}

function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1" aria-hidden="true">
      {keys.map((key) => (
        <Kbd key={key}>{key}</Kbd>
      ))}
    </span>
  )
}

function Glyph({ d }: { d: string }) {
  return (
    <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center text-muted" aria-hidden="true">
      <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d={d} />
      </svg>
    </span>
  )
}

// Small line icons, drawn on a 16 grid like the rest of the app.
const ICON = {
  today: "M3 4.5h10v8.5H3zM3 7h10M5.5 3v3M10.5 3v3",
  tasks: "M3 3.5h4v4H3zM9 3.5h4v4H9zM3 9.5h4v3H3zM9 9.5h4v3H9z",
  lanes: "M2.5 5h11M2.5 8h7M2.5 11h9",
  org: "M8 2.5v3M4 9V7.5h8V9M2.5 9.5h3v3h-3zM6.5 9.5h3v3h-3zM10.5 9.5h3v3h-3zM6 2.5h4v3H6z",
  office: "M2.5 13.5h11M3.5 13.5V6l4.5-3 4.5 3v7.5M6.5 13.5v-4h3v4",
  approvals: "M3 8.5l3 3 7-7",
  routines: "M13 8a5 5 0 1 1-1.5-3.5M13 3v2.5h-2.5",
  devices: "M5 2.5h6v11H5zM7.5 11.5h1",
  projects: "M2.5 4.5h4l1 1.5h6v6.5h-11z",
  search: "M7 3a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM10 10l3 3",
  plus: "M8 3.5v9M3.5 8h9",
  theme: "M8 2.5a5.5 5.5 0 1 0 5.5 5.5A4.5 4.5 0 0 1 8 2.5z",
  settings: "M8 6a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM8 2v1.5M8 12.5V14M2 8h1.5M12.5 8H14M3.8 3.8l1 1M11.2 11.2l1 1M3.8 12.2l1-1M11.2 4.8l1-1",
  keyboard: "M2 4.5h12v7H2zM4.5 7h1M7.5 7h1M10.5 7h1M5 9.5h6",
}

export function CommandPalette() {
  const { openProfile } = useProfileNavigation()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState("")
  const [creating, setCreating] = useState(false)
  const [building, setBuilding] = useState(false)
  const [shortcuts, setShortcuts] = useState(false)
  const [recent, setRecent] = useState<string[]>(readRecent)
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
  const mod = modKey()

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "k") {
        event.preventDefault()
        setOpen((value) => !value)
        return
      }
      if (event.key === "?" && !event.ctrlKey && !event.metaKey && !event.altKey && !typing(event.target)) {
        event.preventDefault()
        setShortcuts(true)
      }
    }
    function onOpen() {
      setOpen(true)
    }
    function onShortcuts() {
      setShortcuts(true)
    }
    window.addEventListener("keydown", onKey)
    window.addEventListener(OPEN_PALETTE_EVENT, onOpen)
    window.addEventListener(OPEN_SHORTCUTS_EVENT, onShortcuts)
    return () => {
      window.removeEventListener("keydown", onKey)
      window.removeEventListener(OPEN_PALETTE_EVENT, onOpen)
      window.removeEventListener(OPEN_SHORTCUTS_EVENT, onShortcuts)
    }
  }, [])

  function openChange(next: boolean) {
    setOpen(next)
    if (!next) setSearch("")
  }

  function choose(entry: Entry) {
    const next = [entry.id, ...recent.filter((id) => id !== entry.id)].slice(0, RECENT_MAX)
    setRecent(next)
    writeRecent(next)
    openChange(false)
    entry.run()
  }

  function go(to: "/" | "/tasks" | "/lanes" | "/organization" | "/office" | "/routines" | "/settings/devices" | "/p") {
    return () => void navigate({ to })
  }

  function openToday() {
    writeOpen(true)
    if (pathname === "/") window.dispatchEvent(new Event(OPEN_TODAY_EVENT))
    else void navigate({ to: "/" })
  }

  const rooms = (channels.data ?? []).filter((channel) => !isDirect(channel))
  const others = (members.data ?? []).filter((member) => member.id !== me.data?.id)

  const entries: Entry[] = [
    { id: "go:today", group: "Go to", value: "today brief inbox home", icon: <Glyph d={ICON.today} />, label: "Today", run: openToday },
    { id: "go:tasks", group: "Go to", value: "tasks board", icon: <Glyph d={ICON.tasks} />, label: "Tasks", run: go("/tasks") },
    {
      id: "go:lanes",
      group: "Go to",
      value: "lanes page",
      icon: <Glyph d={ICON.lanes} />,
      label: "Lanes",
      hint: <Keys keys={["Alt", "L"]} />,
      run: go("/lanes"),
    },
    { id: "go:projects", group: "Go to", value: "projects", icon: <Glyph d={ICON.projects} />, label: "Projects", run: go("/p") },
    { id: "go:org", group: "Go to", value: "organization departments", icon: <Glyph d={ICON.org} />, label: "Organization", run: go("/organization") },
    { id: "go:office", group: "Go to", value: "office room", icon: <Glyph d={ICON.office} />, label: "Office", run: go("/office") },
    {
      id: "go:approvals",
      group: "Go to",
      value: "approvals needs you",
      icon: <Glyph d={ICON.approvals} />,
      label: "Approvals",
      run: () => void navigate({ to: "/approvals", search: {} }),
    },
    { id: "go:routines", group: "Go to", value: "routines", icon: <Glyph d={ICON.routines} />, label: "Routines", run: go("/routines") },
    { id: "go:devices", group: "Go to", value: "devices settings notifications", icon: <Glyph d={ICON.devices} />, label: "Devices and settings", run: go("/settings/devices") },
    ...rooms.map(
      (channel): Entry => ({
        id: `channel:${channel.id}`,
        group: "Channels",
        value: `channel ${channel.name}`,
        icon: <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center text-faint">#</span>,
        label: channel.name,
        run: () => void navigate({ to: "/c/$channelId", params: { channelId: channel.id } }),
      }),
    ),
    ...others.map(
      (member): Entry => ({
        id: `dm:${member.id}`,
        group: member.kind === "agent" ? "Agents" : "People",
        value: `message ${member.display_name} ${member.handle}`,
        icon: <AgentAvatar member={member} size={20} decorative />,
        label: `Message ${member.display_name}`,
        hint: <span className="ml-auto shrink-0 font-mono text-[11px] text-faint">@{member.handle}</span>,
        run: () => void openDirect(member),
      }),
    ),
    ...others.filter((member) => member.kind === "agent").map((member): Entry => ({
      id: `profile:${member.id}`,
      group: "Agents",
      value: `profile @${member.handle} ${member.display_name}`,
      icon: <AgentAvatar member={member} size={20} decorative />,
      label: `Profile: @${member.handle}`,
      run: () => openProfile(member.handle),
    })),
    ...(lanes.data ?? []).map((lane): Entry => {
      const gauge = laneGauge(lane, now)
      return {
        id: `lane:${lane.id}`,
        group: "Lanes",
        value: `lane ${lane.id} ${lane.health}`,
        icon: (
          <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center" aria-hidden>
            <span className={cx("h-1.5 w-1.5 rounded-full", healthDotClass(gauge.health))} />
          </span>
        ),
        label: <span className="font-mono">{gauge.id}</span>,
        hint: (
          <span className="ml-auto font-mono text-[12px] tabular-nums text-muted" title={gauge.tooltip.join("\n")}>
            {gauge.text}
          </span>
        ),
        run: () => void navigate({ to: "/lanes", search: gauge.href }),
      }
    }),
    {
      id: "action:search",
      group: "Actions",
      value: "search messages",
      icon: <Glyph d={ICON.search} />,
      label: "Search messages",
      hint: <Keys keys={[mod, "Shift", "F"]} />,
      run: () => window.dispatchEvent(new Event(OPEN_SEARCH_EVENT)),
    },
    ...(rooms.length > 0
      ? [{ id: "action:task", group: "Actions" as const, value: "new task give work", icon: <Glyph d={ICON.plus} />, label: "New task", run: () => setBuilding(true) }]
      : []),
    { id: "action:channel", group: "Actions", value: "create channel new channel", icon: <Glyph d={ICON.plus} />, label: "Create channel", run: () => setCreating(true) },
    {
      id: "action:theme",
      group: "Actions",
      value: "toggle theme dark light",
      icon: <Glyph d={ICON.theme} />,
      label: theme.choice === "dark" ? "Use light theme" : "Use dark theme",
      run: theme.toggle,
    },
    ...(inChannel
      ? [
          {
            id: "action:channel-settings",
            group: "Actions" as const,
            value: "open channel settings",
            icon: <Glyph d={ICON.settings} />,
            label: "Open channel settings",
            hint: <Keys keys={[mod, ","]} />,
            run: () => window.dispatchEvent(new Event(OPEN_SETTINGS_EVENT)),
          },
        ]
      : []),
    {
      id: "action:shortcuts",
      group: "Actions",
      value: "keyboard shortcuts help",
      icon: <Glyph d={ICON.keyboard} />,
      label: "Keyboard shortcuts",
      hint: <Keys keys={["?"]} />,
      run: () => setShortcuts(true),
    },
  ]

  // With nothing typed, the last few picks come first and leave their group.
  const recentEntries = search
    ? []
    : recent.map((id) => entries.find((entry) => entry.id === id)).filter((entry): entry is Entry => Boolean(entry))
  const shownRecent = new Set(recentEntries.map((entry) => entry.id))
  // cmdk sorts the items inside a group but cannot move the groups (its
  // selector never finds them), so the group with the best match goes first
  // here. With nothing typed the groups keep their reading order.
  const best = new Map<GroupName, number>()
  if (search) for (const entry of entries) best.set(entry.group, Math.max(best.get(entry.group) ?? 0, defaultFilter(entry.value, search)))
  const groupOrder = search ? GROUPS.slice().sort((a, b) => (best.get(b) ?? 0) - (best.get(a) ?? 0)) : GROUPS

  function item(entry: Entry, prefix = "") {
    return (
      <Command.Item key={prefix + entry.id} value={prefix + entry.value} className={itemClass} onSelect={() => choose(entry)}>
        {entry.icon}
        <span className="min-w-0 truncate">{entry.label}</span>
        {entry.hint}
      </Command.Item>
    )
  }

  return (
    <>
      <Command.Dialog
        open={open}
        onOpenChange={openChange}
        label="Command palette"
        overlayClassName="fixed inset-0 z-40 bg-ink/30"
        contentClassName="fixed left-1/2 top-[12vh] z-50 w-[min(36rem,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-xl border border-line bg-surface shadow-lg"
      >
        <div className="flex items-center gap-2 border-b border-line px-3">
          <Glyph d={ICON.search} />
          <Command.Input
            onValueChange={setSearch}
            placeholder="Go to, search or run a command"
            aria-label="Search commands"
            className="min-h-12 outline-none min-w-0 flex-1 bg-transparent text-[16px] text-ink placeholder:text-faint md:text-[14px]"
          />
          <span className="hidden sm:inline-flex">
            <Kbd>Esc</Kbd>
          </span>
        </div>
        <Command.List className="max-h-[min(24rem,60vh)] overflow-y-auto p-1.5">
          <Command.Empty className="px-3 py-6 text-center text-[13px] text-muted">No matching command.</Command.Empty>
          {recentEntries.length > 0 && <Group heading="Recent">{recentEntries.map((entry) => item(entry, "recent "))}</Group>}
          {groupOrder.map((group) => {
            const list = entries.filter((entry) => entry.group === group && !shownRecent.has(entry.id))
            if (list.length === 0) return null
            return (
              <Group key={group} heading={group}>
                {list.map((entry) => item(entry))}
              </Group>
            )
          })}
        </Command.List>
        <div className="hidden items-center gap-3 border-t border-line px-3 py-2 text-[11px] text-faint sm:flex">
          <span className="flex items-center gap-1">
            <Kbd>Enter</Kbd> to open
          </span>
          <span className="flex items-center gap-1">
            <Kbd>Up</Kbd>
            <Kbd>Down</Kbd> to move
          </span>
          <button
            type="button"
            onClick={() => {
              openChange(false)
              setShortcuts(true)
            }}
            className="ml-auto flex items-center gap-1 rounded hover:text-ink"
          >
            <Kbd>?</Kbd> all shortcuts
          </button>
        </div>
      </Command.Dialog>
      <CreateChannelDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(channel) => void navigate({ to: "/c/$channelId", params: { channelId: channel.id } })}
      />
      {building && (
        <TaskBuilder
          open={building}
          onOpenChange={setBuilding}
          channels={rooms}
          channelId={inChannel ? rooms.find((channel) => pathname === `/c/${channel.id}`)?.id : undefined}
        />
      )}
      <ShortcutsSheet open={shortcuts} onOpenChange={setShortcuts} />
    </>
  )
}

function Group({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    // cmdk finds a group to reorder it by a selector built from its value, so
    // the value must not hold a space ("Go to" would never move).
    <Command.Group heading={heading} value={heading.toLowerCase().replace(/\s+/g, "-")} className={headingClass}>
      {children}
    </Command.Group>
  )
}

interface Shortcut {
  keys: string[][]
  what: string
  joiner?: "or" | "to"
}

function shortcutSections(mod: string): { title: string; items: Shortcut[] }[] {
  return [
    {
      title: "Anywhere",
      items: [
        { keys: [[mod, "K"]], what: "Command palette" },
        { keys: [[mod, "Shift", "F"]], what: "Search messages" },
        { keys: [["Alt", "L"]], what: "Lanes page" },
        { keys: [["?"]], what: "This list" },
      ],
    },
    {
      title: "In a channel",
      items: [
        { keys: [["Enter"]], what: "Send" },
        { keys: [["Shift", "Enter"]], what: "New line" },
        { keys: [[mod, ","]], what: "Channel settings" },
        { keys: [["Esc"]], what: "Close the run or thread panel" },
        { keys: [["A"], ["B"], ["C"]], what: "Pick a choice on a focused question" },
        { keys: [["1"], ["9"]], joiner: "to", what: "Pick an approval option by position" },
        { keys: [["M"], ["K"], ["D"]], what: "Merge, keep or discard a focused write approval" },
        { keys: [["E"]], what: "Edit the commit message" },
      ],
    },
    {
      title: "Office",
      items: [
        { keys: [["+"], ["-"]], what: "Zoom in or out" },
        { keys: [["0"]], what: "Fit the whole room" },
        { keys: [["Up"], ["Down"], ["Left"], ["Right"]], what: "Pan once zoomed" },
        { keys: [["Esc"]], what: "Close the desk card" },
      ],
    },
  ]
}

/** The keyboard shortcuts sheet, opened with "?" or from the palette. */
export function ShortcutsSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const sections = shortcutSections(modKey())
  const content = useRef<HTMLDivElement>(null)
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/30" />
        <Dialog.Content
          ref={content}
          tabIndex={-1}
          // The sheet is read, not filled in: focus it rather than the close button.
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            content.current?.focus()
          }}
          className="fixed left-1/2 outline-none top-[10vh] z-50 flex max-h-[80vh] w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-lg">
          <div className="flex items-center gap-2 border-b border-line px-4 py-3">
            <Dialog.Title className="min-w-0 flex-1 text-[15px] font-semibold">Keyboard shortcuts</Dialog.Title>
            <Dialog.Close
              aria-label="Close"
              className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-muted transition-colors duration-150 hover:bg-sidebar hover:text-ink md:h-8 md:w-8"
            >
              <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <path d="m4 4 8 8M12 4l-8 8" />
              </svg>
            </Dialog.Close>
          </div>
          <Dialog.Description className="sr-only">The keys faztudo listens to.</Dialog.Description>
          <div className="overflow-y-auto px-4 pb-4">
            {sections.map((section) => (
              <section key={section.title} aria-label={section.title} className="pt-3">
                <h3 className="pb-1 text-[11px] font-medium uppercase tracking-wide text-faint">{section.title}</h3>
                <dl className="divide-y divide-line">
                  {section.items.map((item) => (
                    <div key={item.what} className="flex min-h-9 items-center gap-3 py-1 text-[13px]">
                      <dt className="min-w-0 flex-1 text-ink">{item.what}</dt>
                      <dd className="flex shrink-0 items-center gap-1">
                        {item.keys.map((combo, index) => (
                          <span key={combo.join("+")} className="flex items-center gap-1">
                            {index > 0 && <span className="text-[11px] text-faint">{item.joiner ?? "or"}</span>}
                            {combo.map((key) => (
                              <Kbd key={key}>{key}</Kbd>
                            ))}
                          </span>
                        ))}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

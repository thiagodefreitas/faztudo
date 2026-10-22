import * as Menu from "@radix-ui/react-dropdown-menu"
import { Link, useNavigate } from "@tanstack/react-router"
import { useEffect, useRef, useState, type ReactNode } from "react"
import { cx } from "../lib/cx"
import { directPeer, isDirect } from "../lib/direct"
import { offscreenUnread, plainPreview, relativeTime, sortInbox, type InboxItem } from "../lib/inbox"
import { usePins } from "../lib/pins"
import { useOpenDirect } from "../state/direct"
import { useNow } from "../state/now"
import { useChannels, useLanes, useLastMessages, useMe, useMembers } from "../state/queries"
import type { Member } from "../types"
import { AgentAvatar } from "./agent-avatar"
import { CreateChannelDialog } from "./channel-dialogs"
import { OPEN_PALETTE_EVENT } from "./palette"
import { SuggestionsSection } from "./suggestions"
import { TeamIcon } from "./team-icon"
import { TodayBrief } from "./today-brief"

const ICON_BUTTON =
  "inline-flex h-10 w-10 items-center justify-center rounded-full text-muted transition-colors duration-150 hover:bg-sidebar hover:text-ink"

export function InboxPage() {
  const channels = useChannels()
  const members = useMembers()
  const me = useMe()
  const openDirect = useOpenDirect()
  const navigate = useNavigate()
  const now = useNow()
  const { pins, toggle } = usePins()
  const [creating, setCreating] = useState(false)
  const lanes = useLanes()
  const lanesUnknown = lanes.isSuccess && lanes.data.every((lane) => lane.health === "unknown")
  const list = channels.data ?? []
  const people = members.data ?? []
  const last = useLastMessages(list.map((channel) => channel.id))
  const items = sortInbox(list.map((channel) => ({ channel, last: last.get(channel.id) })))
  const agents = people.filter((member) => member.kind === "agent")
  const pinned = pins.map((id) => agents.find((agent) => agent.id === id)).filter((agent): agent is Member => Boolean(agent))
  const scroller = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState<Set<string> | null>(null)

  // Without IntersectionObserver (old browsers, jsdom) every row counts as
  // visible and the pill stays hidden.
  useEffect(() => {
    const root = scroller.current
    if (!root || typeof IntersectionObserver === "undefined") return
    const seen = new Set<string>()
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.channel
          if (!id) continue
          if (entry.isIntersecting) seen.add(id)
          else seen.delete(id)
        }
        setVisible(new Set(seen))
      },
      { root },
    )
    root.querySelectorAll("[data-channel]").forEach((row) => observer.observe(row))
    return () => observer.disconnect()
  }, [items.length])

  const hidden = visible ? offscreenUnread(items, visible) : []
  const unreadTotal = items.filter((item) => item.channel.unread > 0).length

  function jumpToUnread() {
    const id = hidden[0]
    if (!id) return
    scroller.current?.querySelector(`[data-channel="${id}"]`)?.scrollIntoView?.({ block: "center", behavior: "smooth" })
  }

  const hour = new Date(now).getHours()
  const greeting = hour < 5 ? "Good evening" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening"
  const firstName = me.data?.display_name?.split(/\s+/)[0]
  const date = new Date(now).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })

  const pinMenu = (trigger: ReactNode) => (
    <Menu.Root>
      {trigger}
      <Menu.Portal>
        <Menu.Content
          align="start"
          sideOffset={6}
          className="z-50 min-w-48 rounded-lg border border-line bg-surface p-1 shadow-lg"
        >
          {agents.map((agent) => (
            <Menu.CheckboxItem
              key={agent.id}
              checked={pins.includes(agent.id)}
              onCheckedChange={() => toggle(agent.id)}
              className="flex min-h-10 cursor-default items-center gap-2 rounded-md px-2 text-[13px] outline-none data-[highlighted]:bg-accent-soft md:min-h-9"
            >
              <AgentAvatar member={agent} size={20} decorative />
              <span className="min-w-0 flex-1 truncate">{agent.display_name}</span>
              <Menu.ItemIndicator className="text-[11px] text-accent">Pinned</Menu.ItemIndicator>
            </Menu.CheckboxItem>
          ))}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="mx-auto flex w-full max-w-3xl items-center gap-2 px-4 pb-2 pt-3">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[17px] font-semibold tracking-tight">
            {greeting}
            {firstName ? `, ${firstName}` : ""}
          </h1>
          <p className="truncate text-[12px] text-muted">{date}</p>
        </div>
        <button type="button" aria-label="Search" title="Search (Ctrl+K)" onClick={() => window.dispatchEvent(new Event(OPEN_PALETTE_EVENT))} className={ICON_BUTTON}>
          <svg viewBox="0 0 20 20" className="h-[18px] w-[18px]" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <circle cx="9" cy="9" r="5.5" />
            <path d="m13.5 13.5 3.5 3.5" />
          </svg>
        </button>
        <button type="button" aria-label="New conversation" title="New conversation" onClick={() => setCreating(true)} className={ICON_BUTTON}>
          <svg viewBox="0 0 20 20" className="h-[18px] w-[18px]" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M10 4v12M4 10h12" />
          </svg>
        </button>
        <CreateChannelDialog
          open={creating}
          onOpenChange={setCreating}
          onCreated={(channel) => void navigate({ to: "/c/$channelId", params: { channelId: channel.id } })}
        />
      </header>
      {pinned.length > 0 && (
        <section aria-label="Pinned agents" className="mx-auto flex w-full max-w-3xl items-center gap-1 overflow-x-auto px-3 pb-2">
          {pinned.map((agent) => (
            <button
              key={agent.id}
              type="button"
              onClick={() => void openDirect(agent)}
              className="flex min-h-10 shrink-0 items-center gap-2 rounded-full border border-line bg-surface py-1 pl-1 pr-3 text-[13px] text-ink transition-colors duration-150 hover:bg-sidebar"
            >
              <AgentAvatar member={agent} size={28} state={agent.presence === "busy" ? "working" : undefined} decorative />
              <span className="max-w-32 truncate">{agent.display_name}</span>
            </button>
          ))}
          {pinMenu(
            <Menu.Trigger
              aria-label="Pin agents"
              title="Pin or unpin agents"
              className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-muted transition-colors duration-150 hover:bg-sidebar hover:text-ink"
            >
              <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <path d="M10 5v10M5 10h10" />
              </svg>
            </Menu.Trigger>,
          )}
        </section>
      )}
      <div className="relative min-h-0 flex-1">
        <div ref={scroller} className="h-full overflow-y-auto" data-testid="inbox-list">
          <div className="mx-auto w-full max-w-3xl">
            <TodayBrief />
            <SuggestionsSection />
            <div className="flex min-h-10 items-center gap-2 px-4 pt-3">
              <h2 className="min-w-0 flex-1 text-[11px] font-medium uppercase tracking-wide text-faint">Chats</h2>
              {pinned.length === 0 &&
                agents.length > 0 &&
                pinMenu(
                  <Menu.Trigger className="min-h-8 rounded-md px-2 text-[12px] text-muted transition-colors duration-150 hover:bg-sidebar hover:text-ink">
                    Pin a chat
                  </Menu.Trigger>,
                )}
            </div>
            {channels.isPending && <p className="px-4 py-6 text-[13px] text-muted">Loading chats</p>}
            {!channels.isPending && items.length === 0 && (
              <div data-testid="inbox-empty" className="mx-4 my-4 rounded-xl border border-dashed border-line px-4 py-6 text-center">
                <p className="text-[14px] font-medium">No channels yet</p>
                <p className="mt-1 text-[13px] text-muted">A channel is a shared room for you and your agents.</p>
                <button
                  type="button"
                  onClick={() => setCreating(true)}
                  className="mt-3 min-h-10 rounded-lg bg-accent px-4 text-[13px] font-medium text-canvas transition-colors duration-150 hover:opacity-90"
                >
                  Create your first channel
                </button>
                {lanesUnknown && (
                  <p data-testid="inbox-doctor" className="mt-3 text-[12px] text-muted">
                    No lane has reported yet. Run <code className="font-mono">faztudo doctor</code> in a terminal to check your agent CLIs.
                  </p>
                )}
              </div>
            )}
            {/* The floating unread pill is 40px high and sits 16px above the bottom. */}
            <ul className={hidden.length > 0 ? "pb-16" : "pb-3"} data-padded={hidden.length > 0 || undefined}>
              {items.map((item) => (
                <InboxRow key={item.channel.id} item={item} members={people} meId={me.data?.id} now={now} />
              ))}
            </ul>
          </div>
        </div>
        {hidden.length > 0 && (
          <button
            type="button"
            onClick={jumpToUnread}
            className="fz-rise absolute bottom-4 left-1/2 min-h-10 -translate-x-1/2 rounded-full bg-accent px-4 text-[13px] font-medium text-canvas shadow-lg"
          >
            {unreadTotal} unread
          </button>
        )}
      </div>
    </div>
  )
}

function InboxRow({
  item,
  members,
  meId,
  now,
}: {
  item: InboxItem
  members: Member[]
  meId: string | undefined
  now: number
}) {
  const { channel, last } = item
  const direct = isDirect(channel)
  const peer = directPeer(channel, meId, members)
  const name = direct ? (peer?.display_name ?? channel.name) : channel.name
  const author = last ? members.find((member) => member.id === last.author_id) : undefined
  const prefix = !last ? "" : last.author_id === meId ? "You: " : direct ? "" : `${author?.display_name ?? "Member"}: `
  const unread = channel.unread
  return (
    <li>
      <Link
        to="/c/$channelId"
        params={{ channelId: channel.id }}
        data-channel={channel.id}
        className="mx-2 flex min-h-16 items-center gap-3 rounded-lg px-2 py-2 transition-colors duration-150 hover:bg-sidebar"
      >
        {direct && peer ? (
          <AgentAvatar member={peer} size={36} decorative />
        ) : (
          <TeamIcon channel={channel} members={members} excludeId={meId} size={36} layout="cluster" />
        )}
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className={cx("min-w-0 flex-1 truncate text-[14px]", unread > 0 ? "font-semibold" : "font-medium")}>
              {direct ? "" : "# "}
              {name}
            </span>
            <time className="shrink-0 text-[11px] tabular-nums text-faint" dateTime={last?.created_at}>
              {relativeTime(last?.created_at, now)}
            </time>
          </span>
          <span className="flex items-center gap-2">
            <span className={cx("min-w-0 flex-1 truncate text-[13px]", unread > 0 ? "text-ink" : "text-muted")}>
              {last ? `${prefix}${plainPreview(last.body)}` : "No messages yet"}
            </span>
            {unread > 0 && (
              <span className="rounded-full bg-accent px-1.5 text-[11px] font-medium tabular-nums text-canvas" aria-label={`${unread} unread`}>
                {unread}
              </span>
            )}
          </span>
        </span>
      </Link>
    </li>
  )
}

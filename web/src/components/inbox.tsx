import * as Menu from "@radix-ui/react-dropdown-menu"
import { Link, useNavigate } from "@tanstack/react-router"
import { useEffect, useRef, useState } from "react"
import { cx } from "../lib/cx"
import { directPeer, isDirect } from "../lib/direct"
import { offscreenUnread, plainPreview, relativeTime, sortInbox, type InboxItem } from "../lib/inbox"
import { usePins } from "../lib/pins"
import { useOpenDirect } from "../state/direct"
import { useNow } from "../state/now"
import { useChannels, useLastMessages, useMe, useMembers } from "../state/queries"
import type { Member } from "../types"
import { AgentAvatar } from "./agent-avatar"
import { CreateChannelDialog } from "./channel-dialogs"
import { OPEN_PALETTE_EVENT } from "./palette"
import { TeamIcon } from "./team-icon"

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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-1 px-3 py-2">
        <Link to="/settings/devices" aria-label="Settings" className="inline-flex h-10 w-10 items-center justify-center rounded-full">
          <AgentAvatar member={me.data} size={36} decorative />
        </Link>
        <h1 className="min-w-0 flex-1 px-1 text-[17px] font-semibold tracking-tight">Chats</h1>
        <button type="button" aria-label="Search" onClick={() => window.dispatchEvent(new Event(OPEN_PALETTE_EVENT))} className={ICON_BUTTON}>
          <svg viewBox="0 0 20 20" className="h-[18px] w-[18px]" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <circle cx="9" cy="9" r="5.5" />
            <path d="m13.5 13.5 3.5 3.5" />
          </svg>
        </button>
        <button type="button" aria-label="New conversation" onClick={() => setCreating(true)} className={ICON_BUTTON}>
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
      <section aria-label="Pinned agents" className="flex gap-3 overflow-x-auto px-3 pb-3">
        {pinned.map((agent) => (
          <button
            key={agent.id}
            type="button"
            onClick={() => void openDirect(agent)}
            className="flex w-16 shrink-0 flex-col items-center gap-1 rounded-lg py-1 text-[12px] text-ink hover:bg-sidebar"
          >
            <AgentAvatar member={agent} size={48} state={agent.presence === "busy" ? "working" : undefined} decorative />
            <span className="w-full truncate text-center">{agent.display_name}</span>
          </button>
        ))}
        {agents.length > 0 && (
          <Menu.Root>
            <Menu.Trigger
              aria-label="Pin agents"
              className="flex w-16 shrink-0 flex-col items-center gap-1 rounded-lg py-1 text-[12px] text-muted hover:bg-sidebar"
            >
              <span className="flex h-12 w-12 items-center justify-center rounded-lg border border-dashed border-line text-[20px]">+</span>
              <span>Pin</span>
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Content
                align="start"
                sideOffset={6}
                className="z-50 min-w-48 rounded-md border border-line bg-surface p-1 shadow-lg"
              >
                {agents.map((agent) => (
                  <Menu.CheckboxItem
                    key={agent.id}
                    checked={pins.includes(agent.id)}
                    onCheckedChange={() => toggle(agent.id)}
                    className="flex min-h-10 cursor-default items-center gap-2 rounded px-2 text-[13px] outline-none data-[highlighted]:bg-accent-soft"
                  >
                    <AgentAvatar member={agent} size={20} decorative />
                    <span className="min-w-0 flex-1 truncate">{agent.display_name}</span>
                    <Menu.ItemIndicator className="text-[11px] text-accent">Pinned</Menu.ItemIndicator>
                  </Menu.CheckboxItem>
                ))}
              </Menu.Content>
            </Menu.Portal>
          </Menu.Root>
        )}
      </section>
      <div className="relative min-h-0 flex-1">
        <div ref={scroller} className="h-full overflow-y-auto border-t border-line" data-testid="inbox-list">
          {channels.isPending && <p className="px-4 py-6 text-[13px] text-muted">Loading chats</p>}
          {!channels.isPending && items.length === 0 && <p className="px-4 py-6 text-[13px] text-muted">No channels yet.</p>}
          <ul>
            {items.map((item) => (
              <InboxRow key={item.channel.id} item={item} members={people} meId={me.data?.id} now={now} />
            ))}
          </ul>
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
        className="flex min-h-16 items-center gap-3 border-b border-line px-3 py-2 hover:bg-sidebar"
      >
        {direct && peer ? (
          <AgentAvatar member={peer} size={36} decorative />
        ) : (
          <TeamIcon channel={channel} members={members} excludeId={meId} size={28} className="w-9 justify-start" />
        )}
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className={cx("min-w-0 flex-1 truncate text-[14px]", unread > 0 ? "font-semibold" : "font-medium")}>
              {direct ? "" : "# "}
              {name}
            </span>
            <time className="shrink-0 text-[11px] text-faint" dateTime={last?.created_at}>
              {relativeTime(last?.created_at, now)}
            </time>
          </span>
          <span className="flex items-center gap-2">
            <span className={cx("min-w-0 flex-1 truncate text-[13px]", unread > 0 ? "text-ink" : "text-muted")}>
              {last ? `${prefix}${plainPreview(last.body)}` : "No messages yet"}
            </span>
            {unread > 0 && (
              <span className="rounded-full bg-accent px-1.5 text-[11px] font-medium text-canvas" aria-label={`${unread} unread`}>
                {unread}
              </span>
            )}
          </span>
        </span>
      </Link>
    </li>
  )
}

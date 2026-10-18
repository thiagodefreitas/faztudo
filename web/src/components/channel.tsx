import * as Menu from "@radix-ui/react-dropdown-menu"
import { Link, getRouteApi, useNavigate } from "@tanstack/react-router"
import { useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { ApiError, api } from "../api/client"
import { directPeer, isDirect } from "../lib/direct"
import { ulid } from "../lib/id"
import { qk } from "../state/keys"
import { mergeById } from "../state/merge"
import { sortMessages } from "../state/reduce"
import { projectOfChannel } from "../lib/projects"
import { useChannels, useMe, useMembers, useOrg, type PendingMessage } from "../state/queries"
import { toggleChannelMute, useNotifyPrefs } from "../lib/notify-prefs"
import type { Attachment, Channel, Message } from "../types"
import { ActivityStrip } from "./activity-strip"
import { Composer } from "./composer"
import { MessageList } from "./message-list"
import { RunPanel } from "./run-panel"
import { ChannelSettingsDialog } from "./channel-dialogs"
import { AgentAvatar } from "./agent-avatar"
import { MembersPanel } from "./members-panel"
import { TeamIcon } from "./team-icon"
import { ThreadPanel } from "./thread-panel"
import { OPEN_SETTINGS_EVENT } from "./palette"
import { PinsDialog } from "./pins-dialog"
import { OPEN_SEARCH_EVENT } from "./search-dialog"

const channelApi = getRouteApi("/c/$channelId")

const MENU_ITEM = "flex min-h-10 cursor-default items-center rounded px-2 text-[13px] text-ink outline-none data-[highlighted]:bg-accent-soft"

const HEADER_ICON = "inline-flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-sidebar hover:text-ink aria-pressed:text-accent"

// The header shows the folder name only, so screenshots do not leak home paths.
export function repoName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

function errorText(error: unknown): string {
  if (error instanceof ApiError) return error.message
  if (error instanceof Error) return error.message
  return "Send failed"
}

export function ChannelPage() {
  const { channelId } = channelApi.useParams()
  const search = channelApi.useSearch()
  const qc = useQueryClient()
  const channels = useChannels()
  const members = useMembers()
  const me = useMe()
  const org = useOrg()
  const navigate = useNavigate()
  const channel = channels.data?.find((item) => item.id === channelId)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [membersOpen, setMembersOpen] = useState(false)
  const [pinsOpen, setPinsOpen] = useState(false)
  const notify = useNotifyPrefs()
  const muted = notify.muted.includes(channelId)

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key === ",") {
        event.preventDefault()
        setSettingsOpen(true)
      }
    }
    function onPalette() {
      setSettingsOpen(true)
    }
    window.addEventListener("keydown", onKey)
    window.addEventListener(OPEN_SETTINGS_EVENT, onPalette)
    return () => {
      window.removeEventListener("keydown", onKey)
      window.removeEventListener(OPEN_SETTINGS_EVENT, onPalette)
    }
  }, [])

  useEffect(() => {
    if (!channel || channel.unread <= 0 || !channel.last_seq) return
    const seq = channel.last_seq
    const id = channel.id
    let cancelled = false
    void api.markRead(id, { seq }).then(() => {
      if (cancelled) return
      qc.setQueryData<Channel[]>(qk.channels, (list = []) =>
        list.map((item) => (item.id === id ? { ...item, unread: 0 } : item)),
      )
    })
    return () => {
      cancelled = true
    }
  }, [channel, qc])

  function remember(item: PendingMessage) {
    qc.setQueryData<PendingMessage[]>(qk.pending(channelId), (list = []) => {
      const index = list.findIndex((entry) => entry.key === item.key)
      if (index === -1) return [...list, item]
      const copy = list.slice()
      copy[index] = item
      return copy
    })
  }

  function dropPending(key: string) {
    qc.setQueryData<PendingMessage[]>(qk.pending(channelId), (list = []) => list.filter((item) => item.key !== key))
  }

  function send(body: string, attachments?: Attachment[], key = ulid()) {
    const files = attachments && attachments.length > 0 ? attachments : undefined
    remember({ key, body, ...(files ? { attachments: files } : {}), createdAt: new Date().toISOString() })
    const refs = files?.map(({ id, name }) => ({ id, name }))
    void api.postMessage(channelId, { body, ...(refs ? { attachments: refs } : {}), idempotency_key: key }).then(
      (message) => {
        qc.setQueryData<Message[]>(qk.messages(channelId), (list = []) => sortMessages(mergeById([message], list)))
        dropPending(key)
      },
      (error: unknown) => {
        remember({ key, body, ...(files ? { attachments: files } : {}), createdAt: new Date().toISOString(), error: errorText(error) })
      },
    )
  }

  function openThread(message: Message) {
    void navigate({ to: "/c/$channelId", params: { channelId }, search: { thread: message.id } })
  }

  if (channels.isPending) return <p className="p-4 text-[13px] text-muted">Loading channel</p>
  if (!channel) return <p className="p-4 text-[13px] text-muted">Channel not found.</p>

  const peer = directPeer(channel, me.data?.id, members.data ?? [])
  const direct = isDirect(channel)
  const title = direct ? (peer?.display_name ?? channel.name) : channel.name
  const agents = (members.data ?? []).filter((member) => member.kind === "agent" && channel.member_ids.includes(member.id))
  const defaultAgent = agents.find((agent) => agent.id === channel.default_agent_id)
  const project = direct ? undefined : projectOfChannel(channel, org.data?.projects ?? [])
  const others = channel.member_ids.filter((id) => id !== me.data?.id).length
  const membersLabel = `${others} ${others === 1 ? "member" : "members"}${defaultAgent ? `, default @${defaultAgent.handle}` : ""}`

  return (
    <div className="flex min-h-0 flex-1">
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 px-3 py-2 max-md:pt-3 md:gap-3 md:border-b md:border-line">
          <Link
            to="/"
            aria-label="Back to chats"
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-line bg-surface text-ink shadow-sm md:hidden"
          >
            <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="m12 4-6 6 6 6" />
            </svg>
          </Link>
          <div className="flex min-w-0 flex-1 items-center gap-2.5 max-md:h-10 max-md:rounded-full max-md:border max-md:border-line max-md:bg-surface max-md:px-3 max-md:shadow-sm">
            {direct && peer ? (
              <AgentAvatar member={peer} size={28} decorative />
            ) : (
              <button
                type="button"
                onClick={() => setMembersOpen(true)}
                aria-label={`Members: ${membersLabel}`}
                title="Members"
                className="inline-flex shrink-0 items-center rounded-md hover:bg-sidebar"
              >
                <TeamIcon channel={channel} members={members.data ?? []} excludeId={me.data?.id} size={20} />
              </button>
            )}
            <div className="min-w-0 flex-1">
              <h1 className="flex min-w-0 items-center gap-2 text-[15px] font-semibold">
                <span className="truncate">
                  <span className="text-faint">{direct ? "@ " : "# "}</span>
                  {title}
                </span>
                {project && (
                  <Link
                    to="/p/$handle"
                    params={{ handle: project.handle }}
                    className="hidden shrink-0 rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent hover:underline md:inline-block"
                    title={`Project ${project.name}`}
                  >
                    {project.name}
                  </Link>
                )}
              </h1>
              {channel.topic && <p className="truncate text-[13px] text-muted max-md:hidden">{channel.topic}</p>}
            </div>
          </div>
          {!direct && (
            <button
              type="button"
              onClick={() => setMembersOpen(true)}
              className="hidden shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-muted hover:bg-sidebar hover:text-ink sm:flex"
              title="Members"
            >
              <span className="font-mono tabular-nums">{others}</span>
              <span>{others === 1 ? "member" : "members"}</span>
              {defaultAgent && <span className="text-faint">, default @{defaultAgent.handle}</span>}
            </button>
          )}
          {channel.repo_path && (
            <p
              className="hidden max-w-48 shrink-0 truncate font-mono text-[12px] text-faint sm:block"
              title={channel.repo_path}
            >
              {repoName(channel.repo_path)}
            </p>
          )}
          <div className="hidden shrink-0 items-center gap-1 md:flex">
            <button type="button" aria-label="Search messages" title="Search messages (Ctrl+Shift+F)" onClick={() => window.dispatchEvent(new Event(OPEN_SEARCH_EVENT))} className={HEADER_ICON}>
              <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
                <circle cx="9" cy="9" r="5" />
                <path d="m13 13 4 4" />
              </svg>
            </button>
            <button type="button" aria-label="Pinned messages" title="Pinned messages" onClick={() => setPinsOpen(true)} className={HEADER_ICON}>
              <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="m12 3 5 5-2 1-2.5 3.5.5 2.5-1 1-3-3-4.5 4.5M7 8l-1-1 1-1 1.5 1.5" />
              </svg>
            </button>
            <button
              type="button"
              aria-label={muted ? "Unmute channel" : "Mute channel"}
              aria-pressed={muted}
              title={muted ? "Unmute notifications for this channel" : "Mute notifications for this channel"}
              onClick={() => toggleChannelMute(channelId)}
              className={HEADER_ICON}
            >
              <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 14V9a5 5 0 0 1 10 0v5l1 1H4zM8.5 17.5h3" />
                {muted && <path d="m3 3 14 14" />}
              </svg>
            </button>
          </div>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            aria-keyshortcuts="Control+Comma Meta+Comma"
            title="Channel settings (Ctrl+, or Cmd+,)"
            className="hidden min-h-8 shrink-0 rounded-md border border-line px-3 text-[12px] hover:bg-sidebar md:block"
          >
            Settings <kbd className="ml-1 hidden font-mono text-[11px] text-faint sm:inline">Ctrl+,</kbd>
          </button>
          <Menu.Root>
            <Menu.Trigger
              aria-label="More"
              className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-line bg-surface text-ink shadow-sm md:hidden"
            >
              <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden="true" fill="currentColor">
                <circle cx="4.5" cy="10" r="1.6" />
                <circle cx="10" cy="10" r="1.6" />
                <circle cx="15.5" cy="10" r="1.6" />
              </svg>
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Content align="end" sideOffset={6} className="z-50 min-w-44 rounded-md border border-line bg-surface p-1 shadow-lg">
                <Menu.Item onSelect={() => window.dispatchEvent(new Event(OPEN_SEARCH_EVENT))} className={MENU_ITEM}>
                  Search messages
                </Menu.Item>
                <Menu.Item onSelect={() => setPinsOpen(true)} className={MENU_ITEM}>
                  Pinned messages
                </Menu.Item>
                <Menu.Item onSelect={() => toggleChannelMute(channelId)} className={MENU_ITEM}>
                  {muted ? "Unmute channel" : "Mute channel"}
                </Menu.Item>
                <Menu.Item onSelect={() => setSettingsOpen(true)} className={MENU_ITEM}>
                  Settings
                </Menu.Item>
                {!direct && (
                  <Menu.Item onSelect={() => setMembersOpen(true)} className={MENU_ITEM}>
                    Members
                  </Menu.Item>
                )}
                <Menu.Item asChild>
                  <Link to="/lanes" className={MENU_ITEM}>
                    Lanes
                  </Link>
                </Menu.Item>
              </Menu.Content>
            </Menu.Portal>
          </Menu.Root>
          <ChannelSettingsDialog channel={channel} agents={agents} open={settingsOpen} onOpenChange={setSettingsOpen} />
          <MembersPanel channel={channel} open={membersOpen} onOpenChange={setMembersOpen} />
        </header>
        <ActivityStrip
          key={channelId}
          channel={channel}
          onOpenRun={(runId) => void navigate({ to: "/c/$channelId", params: { channelId }, search: { run: runId } })}
        />
        <MessageList
          key={channelId}
          channelId={channelId}
          {...(search.m ? { focusId: search.m } : {})}
          onRetry={(item) => send(item.body, item.attachments, item.key)}
          onOpenThread={openThread}
        />
        <Composer
          members={members.data ?? []}
          channelName={channel.name}
          attach
          {...(direct ? { placeholder: `Message ${title}` } : {})}
          onSend={(body, attachments) => send(body, attachments)}
        />
        <PinsDialog channelId={channelId} open={pinsOpen} onOpenChange={setPinsOpen} />
      </section>
      {search.thread ? (
        <ThreadPanel key={search.thread} channelId={channelId} rootId={search.thread} />
      ) : (
        search.run && <RunPanel channelId={channelId} runId={search.run} view={search.view} />
      )}
    </div>
  )
}

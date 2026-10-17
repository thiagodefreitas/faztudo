import * as Dialog from "@radix-ui/react-dialog"
import { getRouteApi } from "@tanstack/react-router"
import { useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { ApiError, api } from "../api/client"
import { ulid } from "../lib/id"
import { qk } from "../state/keys"
import { mergeById } from "../state/merge"
import { sortMessages } from "../state/reduce"
import { useChannels, useMembers, type PendingMessage } from "../state/queries"
import type { Channel, Message } from "../types"
import { Composer } from "./composer"
import { MessageList } from "./message-list"
import { RunPanel } from "./run-panel"
import { ChannelSettingsDialog } from "./channel-dialogs"
import { WorkspaceNav } from "./sidebar"

const channelApi = getRouteApi("/c/$channelId")

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
  const channel = channels.data?.find((item) => item.id === channelId)
  const [navOpen, setNavOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key === ",") {
        event.preventDefault()
        setSettingsOpen(true)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
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

  function send(body: string, key = ulid()) {
    remember({ key, body, createdAt: new Date().toISOString() })
    void api.postMessage(channelId, { body, idempotency_key: key }).then(
      (message) => {
        qc.setQueryData<Message[]>(qk.messages(channelId), (list = []) => sortMessages(mergeById([message], list)))
        dropPending(key)
      },
      (error: unknown) => {
        remember({ key, body, createdAt: new Date().toISOString(), error: errorText(error) })
      },
    )
  }

  if (channels.isPending) return <p className="p-4 text-[13px] text-muted">Loading channel</p>
  if (!channel) return <p className="p-4 text-[13px] text-muted">Channel not found.</p>

  return (
    <div className="flex min-h-0 flex-1">
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex items-start gap-3 border-b border-line px-3 py-2">
          <Dialog.Root open={navOpen} onOpenChange={setNavOpen}>
            <Dialog.Trigger className="min-h-8 rounded border border-line px-2 text-[12px] md:hidden">Channels</Dialog.Trigger>
            <Dialog.Portal>
              <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/40" />
              <Dialog.Content className="fixed inset-y-0 left-0 z-50 flex w-72 flex-col bg-sidebar p-2 shadow-lg">
                <Dialog.Title className="px-2 pt-2 text-[13px] font-medium">Channels</Dialog.Title>
                <WorkspaceNav onNavigate={() => setNavOpen(false)} />
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[15px] font-semibold">
              <span className="text-faint"># </span>
              {channel.name}
            </h1>
            {channel.topic && <p className="truncate text-[13px] text-muted">{channel.topic}</p>}
          </div>
          {channel.repo_path && (
            <p className="hidden max-w-48 truncate font-mono text-[12px] text-faint sm:block">{channel.repo_path}</p>
          )}
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            aria-keyshortcuts="Control+Comma Meta+Comma"
            title="Channel settings (Ctrl+, or Cmd+,)"
            className="min-h-8 shrink-0 rounded border border-line px-2 text-[12px]"
          >
            Settings <kbd className="ml-1 hidden font-mono text-[11px] text-faint sm:inline">Ctrl+,</kbd>
          </button>
          <ChannelSettingsDialog channel={channel} open={settingsOpen} onOpenChange={setSettingsOpen} />
        </header>
        <MessageList key={channelId} channelId={channelId} onRetry={(item) => send(item.body, item.key)} />
        <Composer members={members.data ?? []} channelName={channel.name} onSend={(body) => send(body)} />
      </section>
      {search.run && <RunPanel channelId={channelId} runId={search.run} view={search.view} />}
    </div>
  )
}

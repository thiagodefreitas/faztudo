import * as Dialog from "@radix-ui/react-dialog"
import { useNavigate } from "@tanstack/react-router"
import { useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { api } from "../api/client"
import { plainPreview } from "../lib/inbox"
import { formatClock } from "../lib/time"
import { qk } from "../state/keys"
import { useChannelPins, useMembers } from "../state/queries"
import type { Pin } from "../types"
import { AgentAvatar } from "./agent-avatar"

// The messages pinned in one channel, newest pin first.
export function PinsDialog({
  channelId,
  open,
  onOpenChange,
}: {
  channelId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const pins = useChannelPins(channelId)
  const members = useMembers()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [failed, setFailed] = useState(false)

  function show(pin: Pin) {
    onOpenChange(false)
    const message = pin.message
    const search = message.thread_id ? { thread: message.thread_id } : { m: message.id }
    void navigate({ to: "/c/$channelId", params: { channelId }, search })
  }

  async function unpin(pin: Pin) {
    setFailed(false)
    try {
      await api.unpinMessage(pin.message_id)
      await qc.invalidateQueries({ queryKey: qk.messagePins(channelId) })
    } catch {
      setFailed(true)
    }
  }

  const list = pins.data ?? []
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/40" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-[10vh] z-50 flex max-h-[80vh] w-[min(36rem,calc(100vw-1.5rem))] -translate-x-1/2 flex-col overflow-hidden rounded-lg border border-line bg-surface shadow-lg"
        >
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <Dialog.Title className="text-[14px] font-semibold">Pinned messages</Dialog.Title>
            <Dialog.Close className="min-h-10 rounded px-2 text-[13px] text-muted hover:text-ink md:min-h-8">Close</Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {pins.isPending && <p className="px-2 py-4 text-[13px] text-muted">Loading</p>}
            {pins.isError && <p className="px-2 py-4 text-[13px] text-danger">Could not load the pinned messages.</p>}
            {pins.isSuccess && list.length === 0 && (
              <p className="px-2 py-4 text-[13px] text-muted">Nothing is pinned here yet. Use Pin on a message to keep it handy.</p>
            )}
            {failed && (
              <p role="alert" className="px-2 py-1 text-[13px] text-danger">
                Could not unpin. Try again.
              </p>
            )}
            <ul>
              {list.map((pin) => {
                const author = members.data?.find((member) => member.id === pin.message.author_id)
                const text = plainPreview(pin.message.body) || (pin.message.attachments?.length ? "Sent a file" : "")
                return (
                  <li key={pin.message_id} className="rounded-md px-2 py-2 hover:bg-sidebar">
                    <p className="flex items-center gap-1.5 text-[12px] text-muted">
                      <AgentAvatar member={author} size={16} decorative />
                      <span className="font-medium text-ink">{author?.display_name ?? "Member"}</span>
                      <time className="font-mono text-faint" dateTime={pin.message.created_at}>
                        {formatClock(pin.message.created_at)}
                      </time>
                    </p>
                    <p className="mt-0.5 line-clamp-3 text-[13px] text-ink">{text}</p>
                    <p className="mt-1 flex gap-3 text-[12px]">
                      <button type="button" onClick={() => show(pin)} className="min-h-8 font-medium text-accent hover:underline">
                        Show in channel
                      </button>
                      <button type="button" onClick={() => void unpin(pin)} className="min-h-8 text-muted hover:text-ink hover:underline">
                        Unpin
                      </button>
                    </p>
                  </li>
                )
              })}
            </ul>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

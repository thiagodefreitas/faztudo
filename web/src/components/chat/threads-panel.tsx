import { useEffect, useMemo } from "react"
import { formatAge } from "../../lib/time"
import { plainPreview } from "../../lib/inbox"
import { useNow } from "../../state/now"
import { useMe, useMembers, useMessages } from "../../state/queries"
import type { Message } from "../../types"
import { AgentAvatar } from "../agent-avatar"
import { unreadIds } from "./rows"
import { listThreads } from "./threads"

/** The channel's threads, newest activity first. */
export function ThreadsPanel({
  channelId,
  unread,
  onOpen,
  onClose,
}: {
  channelId: string
  /** How many messages were unread when the channel was opened. */
  unread: number
  onOpen: (root: Message) => void
  onClose: () => void
}) {
  const messages = useMessages(channelId)
  const members = useMembers()
  const me = useMe()
  const now = useNow()
  const all = messages.data
  const threads = useMemo(
    () => listThreads(all ?? [], unreadIds(all ?? [], unread, me.data?.id)),
    [all, unread, me.data?.id],
  )

  // Escape from the composer closes the panel too; the composer prevents
  // default when the key closed its mention popup instead.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return
      const target = event.target
      if (target instanceof HTMLElement && target.closest("input, select, [role='dialog']")) return
      onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  return (
    <aside
      aria-label="Threads"
      className="fixed inset-0 z-30 flex min-h-0 flex-col bg-surface xl:static xl:z-auto xl:w-[22rem] xl:shrink-0 xl:border-l xl:border-line"
    >
      <header className="flex items-center gap-2 border-b border-line px-3 py-2">
        <h2 className="min-w-0 flex-1 truncate text-[13px] font-medium">Threads</h2>
        <button
          type="button"
          onClick={onClose}
          className="min-h-10 rounded px-3 text-[12px] text-muted transition-colors duration-150 hover:bg-sidebar hover:text-ink md:min-h-8 md:px-2"
        >
          Close
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {threads.length === 0 ? (
          <p className="px-3 py-4 text-[13px] text-muted">No threads yet.</p>
        ) : (
          <ul>
            {threads.map((thread) => (
              <li key={thread.root.id} className="border-b border-line">
                <button
                  type="button"
                  onClick={() => onOpen(thread.root)}
                  className="flex min-h-12 w-full flex-col gap-1 px-3 py-2 text-left transition-colors duration-150 hover:bg-sidebar"
                >
                  <span className="flex items-center gap-2">
                    {thread.unread && <span role="img" aria-label="Unread replies" className="h-2 w-2 shrink-0 rounded-full bg-accent" />}
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{plainPreview(thread.root.body) || "Message"}</span>
                  </span>
                  <span className="flex items-center gap-2 text-[12px] text-muted">
                    <span className="flex -space-x-1">
                      {thread.participants.slice(0, 4).map((id) => (
                        <AgentAvatar key={id} member={members.data?.find((member) => member.id === id)} size={20} decorative />
                      ))}
                    </span>
                    <span>
                      {thread.replies} {thread.replies === 1 ? "reply" : "replies"}
                    </span>
                    <span className="text-faint">{formatAge(thread.lastReplyAt, now)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  )
}

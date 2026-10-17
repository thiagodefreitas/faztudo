import { useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { api } from "../api/client"
import { ulid } from "../lib/id"
import { formatClock } from "../lib/time"
import { qk } from "../state/keys"
import { mergeById } from "../state/merge"
import { useMembers, useThread } from "../state/queries"
import type { Message, ThreadPage } from "../types"
import { Composer } from "./composer"
import { Markdown } from "./markdown"

export function ThreadPanel({ channelId, rootId }: { channelId: string; rootId: string }) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const members = useMembers()
  const thread = useThread(channelId, rootId)
  const [error, setError] = useState<string | null>(null)

  function close() {
    void navigate({ to: "/c/$channelId", params: { channelId }, search: {} })
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return
      const target = event.target
      if (target instanceof HTMLElement && target.closest("input, textarea, select, [role='dialog']")) return
      void navigate({ to: "/c/$channelId", params: { channelId }, search: {} })
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [channelId, navigate])

  function send(body: string) {
    setError(null)
    api.postMessage(channelId, { body, thread_id: rootId, idempotency_key: ulid() }).then(
      (reply) => {
        qc.setQueryData<ThreadPage | undefined>(qk.thread(rootId), (page) =>
          page ? { ...page, replies: mergeById([reply], page.replies) } : page,
        )
      },
      (cause: unknown) => setError(cause instanceof Error ? cause.message : "Send failed"),
    )
  }

  function author(message: Message): string {
    return members.data?.find((member) => member.id === message.author_id)?.display_name ?? "Member"
  }

  const count = thread.replies.length
  return (
    <aside
      aria-label="Thread"
      className="fixed inset-0 z-30 flex min-h-0 flex-col bg-surface xl:static xl:z-auto xl:w-[22rem] xl:shrink-0 xl:border-l xl:border-line"
    >
      <header className="flex items-center gap-2 border-b border-line px-3 py-2">
        <h2 className="min-w-0 flex-1 truncate text-[13px] font-medium">
          Thread{count > 0 ? `, ${count} ${count === 1 ? "reply" : "replies"}` : ""}
        </h2>
        <button type="button" onClick={close} className="min-h-8 rounded px-2 text-[12px]">
          Close
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {thread.isPending && <p className="px-3 py-4 text-[13px] text-muted">Loading thread</p>}
        {thread.isError && <p className="px-3 py-4 text-[13px] text-muted">The thread is not available.</p>}
        {thread.root && (
          <ol className="flex flex-col">
            {[thread.root, ...thread.replies].map((message, index) => (
              <li key={message.id} className={index === 0 ? "border-b border-line px-3 py-2" : "px-3 py-2"}>
                <article>
                  <header className="flex items-baseline gap-2">
                    <p className="text-[13px] font-medium">{author(message)}</p>
                    <time className="font-mono text-[11px] text-faint" dateTime={message.created_at}>
                      {formatClock(message.created_at)}
                    </time>
                  </header>
                  <div className="mt-1 text-[14px]">
                    <Markdown text={message.body} />
                  </div>
                </article>
              </li>
            ))}
          </ol>
        )}
      </div>
      {error && (
        <p role="alert" className="border-t border-line px-3 py-1 text-[12px] text-danger">
          {error}
        </p>
      )}
      <Composer members={members.data ?? []} channelName="" label="Reply" placeholder="Reply in thread" onSend={send} />
    </aside>
  )
}

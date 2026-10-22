import * as Menu from "@radix-ui/react-dropdown-menu"
import { useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { api } from "../api/client"
import { ulid } from "../lib/id"
import { qk } from "../state/keys"
import { mergeById } from "../state/merge"
import { routinePromptOf } from "../lib/request"
import { useChannels, useMe, useMembers, useMessages } from "../state/queries"
import type { Member, Message, Run, ThreadPage } from "../types"
import { TeachDialog } from "./lessons/teach-dialog"
import { RepeatDialog } from "./routines/repeat-dialog"

const ITEM = "flex min-h-10 cursor-default items-center rounded px-2 text-[13px] text-ink outline-none data-[highlighted]:bg-accent-soft md:min-h-8"
const TERMINAL = new Set<Run["state"]>(["done", "failed", "cancelled"])

/** The agents that could review: the other agents in the channel, at most four. */
export function reviewers(author: Member | undefined, members: Member[], memberIds: string[]): Member[] {
  return members
    .filter((member) => member.kind === "agent" && member.id !== author?.id && memberIds.includes(member.id))
    .slice(0, 4)
}

/** Lanes of the answering agent other than the one the run used. */
export function otherLanes(author: Member | undefined, run: Run | undefined): string[] {
  if (!run || !TERMINAL.has(run.state)) return []
  return (author?.agent?.lanes ?? []).filter((id) => id !== run.lane_id)
}

// "Ask another agent to review" posts a mention as a reply in the answer's
// thread; "Retry on another lane" starts the same request again on that lane.
export function AnswerActions({
  message,
  author,
  run,
  onOpenThread,
}: {
  message: Message
  author: Member | undefined
  run: Run | undefined
  onOpenThread: ((message: Message) => void) | undefined
}) {
  const qc = useQueryClient()
  const members = useMembers()
  const channels = useChannels()
  const [error, setError] = useState<string | null>(null)
  const channel = channels.data?.find((item) => item.id === message.channel_id)
  const people = reviewers(author, members.data ?? [], channel?.member_ids ?? [])
  const lanes = otherLanes(author, run)
  const me = useMe()
  const [repeatOpen, setRepeatOpen] = useState(false)
  const [teachOpen, setTeachOpen] = useState(false)
  const triggers = useMessages(message.channel_id)
  const trigger = run ? triggers.data?.find((item) => item.id === run.trigger_message_id) : undefined
  // Only a finished run can be repeated, and only from a channel and by an agent
  // that a routine can name.
  const canRepeat = run?.state === "done" && channel !== undefined && author?.kind === "agent"
  // A lesson is taught by the Director, about an agent's answer.
  const canTeach = me.data?.kind === "human" && channel !== undefined && author?.kind === "agent"
  if (people.length === 0 && lanes.length === 0 && !canRepeat && !canTeach) return null

  function ask(agent: Member) {
    setError(null)
    api
      .postMessage(message.channel_id, {
        body: `@${agent.handle} Please review the answer above.`,
        thread_id: message.id,
        idempotency_key: ulid(),
      })
      .then(
        (reply) => {
          qc.setQueryData<ThreadPage | undefined>(qk.thread(message.id), (page) =>
            page ? { ...page, replies: mergeById([reply], page.replies) } : page,
          )
          onOpenThread?.(message)
        },
        () => setError("Could not ask. Try again."),
      )
  }

  function retry(laneId: string) {
    if (!run) return
    setError(null)
    api.retryRun(run.id, { lane_id: laneId }).catch(() => setError("Could not retry on that lane."))
  }

  return (
    <>
      <Menu.Root>
        <Menu.Trigger
          aria-label="More actions"
          title="More answer actions"
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-sidebar hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        >
          <svg viewBox="0 0 20 20" className="h-4 w-4" fill="currentColor" aria-hidden="true"><circle cx="4" cy="10" r="1.5" /><circle cx="10" cy="10" r="1.5" /><circle cx="16" cy="10" r="1.5" /></svg>
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Content align="start" sideOffset={4} className="z-50 min-w-52 rounded-md border border-line bg-surface p-1 shadow-lg">
            {people.map((person) => (
              <Menu.Item key={person.id} onSelect={() => ask(person)} className={ITEM}>
                Ask {person.display_name} to review
              </Menu.Item>
            ))}
            {lanes.map((laneId) => (
              <Menu.Item key={laneId} onSelect={() => retry(laneId)} className={ITEM}>
                Retry on {laneId}
              </Menu.Item>
            ))}
            {canRepeat && (
              <Menu.Item onSelect={() => setRepeatOpen(true)} className={ITEM}>
                Repeat this
              </Menu.Item>
            )}
            {canTeach && author && (
              <Menu.Item onSelect={() => setTeachOpen(true)} className={ITEM}>
                Teach @{author.handle}...
              </Menu.Item>
            )}
          </Menu.Content>
        </Menu.Portal>
      </Menu.Root>
      {repeatOpen && channel && author && (
        <RepeatDialog
          request={routinePromptOf(trigger?.body)}
          persona={author.handle}
          channel={channel.name}
          open
          onOpenChange={setRepeatOpen}
        />
      )}
      {teachOpen && channel && author && (
        <TeachDialog
          persona={author.handle}
          channelId={channel.id}
          channelName={channel.name}
          sourceMessageId={message.id}
          open
          onOpenChange={setTeachOpen}
        />
      )}
      {error && (
        <span role="alert" className="text-danger">
          {error}
        </span>
      )}
    </>
  )
}

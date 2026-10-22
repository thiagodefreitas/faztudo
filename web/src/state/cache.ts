import type { QueryClient } from "@tanstack/react-query"
import type { Lesson, Member, Message, NoticeItem, OutputLine, StreamEvent, Task } from "../types"
import { qk } from "./keys"
import { replaceById } from "./merge"
import { emptySnapshot, reduce } from "./reduce"

function messageChannel(qc: QueryClient, event: StreamEvent): string | undefined {
  if (event.type === "message.posted") {
    const payload = event.payload as { channel_id?: unknown } | null
    return typeof payload?.channel_id === "string" ? payload.channel_id : undefined
  }
  if (event.channel_id) return event.channel_id
  const payload = event.payload as { id?: unknown } | null
  if (typeof payload?.id !== "string") return undefined
  // Old edit events may lack a channel. Only that rare case needs a lookup.
  for (const query of qc.getQueryCache().findAll({ queryKey: ["messages"] })) {
    if (Array.isArray(query.state.data) && (query.state.data as Message[]).some((item) => item.id === payload.id)) {
      return query.queryKey[1] as string
    }
  }
  return undefined
}

export function applyEvent(qc: QueryClient, event: StreamEvent): void {
  const lastSeq = qc.getQueryData<number>(qk.seq) ?? 0
  if (!Number.isFinite(event.seq) || event.seq <= lastSeq) return
  // Keep this cursor for every event, including events without a local projection.
  qc.setQueryData(qk.seq, event.seq)
  if (event.type === "project.updated" || event.type === "department.updated") {
    void qc.invalidateQueries({ queryKey: qk.org })
  }
  if (event.type === "routine.updated" || event.type === "routine.removed") {
    void qc.invalidateQueries({ queryKey: qk.routines })
  }
  if (event.type === "lesson.added" || event.type === "lesson.updated" || event.type === "lesson.removed") {
    const lesson = event.payload as Lesson | null
    if (lesson && typeof lesson.id === "string") {
      qc.setQueryData<Lesson[] | undefined>(qk.lessons, (current) => {
        if (!current) return current
        return event.type === "lesson.removed" ? current.filter((item) => item.id !== lesson.id) : replaceById(current, lesson)
      })
    }
  }
  if (event.type === "compare.started" || event.type === "compare.decided") {
    if (event.channel_id) void qc.invalidateQueries({ queryKey: ["compares", event.channel_id] })
  }
  if ((event.type === "run.created" || event.type === "run.updated") && event.channel_id) {
    const run = event.payload as { id?: unknown } | null
    const groups = qc.getQueryData<{ candidates: { run?: { id: string } }[] }[]>(["compares", event.channel_id])
    if (typeof run?.id === "string" && groups?.some((group) => group.candidates.some((candidate) => candidate.run?.id === run.id))) {
      void qc.invalidateQueries({ queryKey: ["compares", event.channel_id] })
    }
  }
  if (event.type === "task.created" || event.type === "task.updated") {
    const task = event.payload as Task | null
    if (task && typeof task.id === "string") {
      qc.setQueryData<Task[]>(qk.tasks, (current) => replaceById(current ?? [], task))
    }
    return
  }
  if ((event.type === "message.pinned" || event.type === "message.unpinned") && event.channel_id) {
    void qc.invalidateQueries({ queryKey: qk.messagePins(event.channel_id) })
  }

  const prev = emptySnapshot()
  prev.lastSeq = lastSeq
  const channelId = event.type === "message.posted" || event.type === "message.edited" ? messageChannel(qc, event) : undefined
  if (channelId) prev.messages[channelId] = qc.getQueryData<Message[]>(qk.messages(channelId)) ?? []
  const runId = event.type === "run.output" ? (event.payload as { run_id?: unknown } | null)?.run_id : undefined
  if (typeof runId === "string") prev.output[runId] = qc.getQueryData<OutputLine[]>(qk.output(runId)) ?? []
  switch (event.type) {
    case "channel.created":
    case "channel.updated": prev.channels = qc.getQueryData(qk.channels) ?? []; break
    case "member.updated":
    case "presence.changed": prev.members = qc.getQueryData(qk.members) ?? []; break
    case "run.created":
    case "run.updated": prev.runs = qc.getQueryData(qk.runs) ?? []; break
    case "lane.switched":
      prev.runs = qc.getQueryData(qk.runs) ?? []
      prev.notices = qc.getQueryData(qk.notices) ?? []
      break
    case "approval.requested":
    case "approval.resolved": prev.approvals = qc.getQueryData(qk.approvals) ?? []; break
    case "lane.updated": prev.lanes = qc.getQueryData(qk.lanes) ?? []; break
    case "notice": prev.notices = qc.getQueryData(qk.notices) ?? []; break
  }
  const next = reduce(prev, event)
  if (next === prev) return
  if (next.channels !== prev.channels) qc.setQueryData(qk.channels, next.channels)
  if (next.members !== prev.members) {
    qc.setQueryData(qk.members, next.members)
    const me = qc.getQueryData<Member>(qk.me)
    const updated = me && next.members.find((member) => member.id === me.id)
    if (updated) qc.setQueryData(qk.me, updated)
  }
  if (next.runs !== prev.runs) qc.setQueryData(qk.runs, next.runs)
  if (next.approvals !== prev.approvals) qc.setQueryData(qk.approvals, next.approvals)
  if (next.lanes !== prev.lanes) qc.setQueryData(qk.lanes, next.lanes)
  if (next.notices !== prev.notices) qc.setQueryData(qk.notices, next.notices)
  if (channelId && next.messages !== prev.messages) qc.setQueryData(qk.messages(channelId), next.messages[channelId])
  if (typeof runId === "string" && next.output !== prev.output) qc.setQueryData(qk.output(runId), next.output[runId])
}

export type { NoticeItem }

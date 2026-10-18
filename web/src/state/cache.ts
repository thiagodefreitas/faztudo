import type { QueryClient } from "@tanstack/react-query"
import type { Member, Message, NoticeItem, OutputLine, StreamEvent } from "../types"
import { qk } from "./keys"
import { emptySnapshot, reduce, type Snapshot } from "./reduce"

function readSnapshot(qc: QueryClient): Snapshot {
  const snapshot = emptySnapshot()
  snapshot.lastSeq = qc.getQueryData<number>(qk.seq) ?? 0
  snapshot.members = qc.getQueryData(qk.members) ?? []
  snapshot.channels = qc.getQueryData(qk.channels) ?? []
  snapshot.runs = qc.getQueryData(qk.runs) ?? []
  snapshot.approvals = qc.getQueryData(qk.approvals) ?? []
  snapshot.lanes = qc.getQueryData(qk.lanes) ?? []
  snapshot.notices = qc.getQueryData(qk.notices) ?? []
  for (const query of qc.getQueryCache().getAll()) {
    const key = query.queryKey
    if (key[0] === "messages" && typeof key[1] === "string" && Array.isArray(query.state.data)) {
      snapshot.messages[key[1]] = query.state.data as Message[]
    }
    if (key[0] === "output" && typeof key[1] === "string" && Array.isArray(query.state.data)) {
      snapshot.output[key[1]] = query.state.data as OutputLine[]
    }
  }
  return snapshot
}

function writeSnapshot(qc: QueryClient, snapshot: Snapshot): void {
  qc.setQueryData(qk.seq, snapshot.lastSeq)
  qc.setQueryData(qk.members, snapshot.members)
  qc.setQueryData(qk.channels, snapshot.channels)
  qc.setQueryData(qk.runs, snapshot.runs)
  qc.setQueryData(qk.approvals, snapshot.approvals)
  qc.setQueryData(qk.lanes, snapshot.lanes)
  qc.setQueryData(qk.notices, snapshot.notices)
  for (const [channelId, messages] of Object.entries(snapshot.messages)) {
    qc.setQueryData(qk.messages(channelId), messages)
  }
  for (const [runId, lines] of Object.entries(snapshot.output)) {
    qc.setQueryData(qk.output(runId), lines)
  }
  const me = qc.getQueryData<Member>(qk.me)
  if (!me) return
  const updated = snapshot.members.find((member) => member.id === me.id)
  if (updated) qc.setQueryData(qk.me, updated)
}

export function applyEvent(qc: QueryClient, event: StreamEvent): void {
  // The organization is not part of the snapshot: refetch it when it changes.
  if (event.type === "project.updated" || event.type === "department.updated") {
    void qc.invalidateQueries({ queryKey: qk.org })
  }
  const prev = readSnapshot(qc)
  const next = reduce(prev, event)
  if (next === prev) return
  writeSnapshot(qc, next)
}

export type { NoticeItem }

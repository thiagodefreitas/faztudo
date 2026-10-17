import { useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "../api/client"
import type { Approval, Message, NoticeItem, OutputLine, ThreadPage } from "../types"
import { qk } from "./keys"
import { mergeById } from "./merge"
import { sortMessages } from "./reduce"

export function useMe() {
  return useQuery({ queryKey: qk.me, queryFn: () => api.me() })
}

export function useMembers() {
  const qc = useQueryClient()
  return useQuery({
    queryKey: qk.members,
    queryFn: async () => mergeById(await api.members(), qc.getQueryData(qk.members) ?? []),
  })
}

export function useChannels() {
  const qc = useQueryClient()
  return useQuery({
    queryKey: qk.channels,
    queryFn: async () => mergeById(await api.channels(), qc.getQueryData(qk.channels) ?? []),
  })
}

export function useLanes() {
  const qc = useQueryClient()
  return useQuery({
    queryKey: qk.lanes,
    queryFn: async () => mergeById(await api.lanes(), qc.getQueryData(qk.lanes) ?? []),
  })
}

export function useRuns() {
  const qc = useQueryClient()
  return useQuery({
    queryKey: qk.runs,
    queryFn: async () => mergeById(await api.runs(), qc.getQueryData(qk.runs) ?? []),
  })
}

export function useApprovals() {
  const qc = useQueryClient()
  return useQuery({
    queryKey: qk.approvals,
    queryFn: async () => mergeById(await api.approvals(), qc.getQueryData(qk.approvals) ?? []),
  })
}

export function useMessages(channelId: string) {
  const qc = useQueryClient()
  return useQuery({
    queryKey: qk.messages(channelId),
    queryFn: async () => {
      const server = await api.messages(channelId, { limit: 100 })
      const local = qc.getQueryData<typeof server>(qk.messages(channelId)) ?? []
      return sortMessages(mergeById(server, local))
    },
  })
}

function mergeLines(server: OutputLine[], local: OutputLine[]): OutputLine[] {
  const bySeq = new Map<number, OutputLine>()
  for (const line of server) bySeq.set(line.seq, line)
  for (const line of local) bySeq.set(line.seq, line)
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
}

export function useOutput(runId: string, enabled = true) {
  const qc = useQueryClient()
  return useQuery({
    queryKey: qk.output(runId),
    enabled,
    queryFn: async () => mergeLines((await api.output(runId)).lines, qc.getQueryData<OutputLine[]>(qk.output(runId)) ?? []),
  })
}

export function useNotices() {
  return useQuery({
    queryKey: qk.notices,
    queryFn: () => Promise.resolve([] as NoticeItem[]),
    initialData: [] as NoticeItem[],
    enabled: false,
  })
}

export function usePending(channelId: string) {
  return useQuery({
    queryKey: qk.pending(channelId),
    queryFn: () => Promise.resolve([] as PendingMessage[]),
    initialData: [] as PendingMessage[],
    enabled: false,
  })
}

export interface PendingMessage {
  key: string
  body: string
  createdAt: string
  error?: string
}

export function approvalForRun(approvals: Approval[] | undefined, runId: string): Approval | null {
  const related = (approvals ?? []).filter((approval) => approval.run_id === runId)
  return related.find((approval) => approval.state === "pending") ?? related.at(-1) ?? null
}

// A thread is its root plus replies. Replies seen on the stream sit in the
// channel cache, replies this client posted sit in the thread cache; both are
// merged over the server page.
export function useThread(channelId: string, rootId: string) {
  const qc = useQueryClient()
  const page = useQuery({
    queryKey: qk.thread(rootId),
    queryFn: async () => {
      const server = await api.thread(rootId)
      const local = qc.getQueryData<ThreadPage>(qk.thread(rootId))
      return { root: server.root, replies: mergeById(server.replies, local?.replies ?? []) }
    },
  })
  const cached = useQuery({
    queryKey: qk.messages(channelId),
    queryFn: () => Promise.resolve([] as Message[]),
    enabled: false,
  })
  const cachedRoot = cached.data?.find((item) => item.id === rootId)
  const live = (cached.data ?? []).filter((item) => item.thread_id === rootId)
  const replies = sortMessages(mergeById(page.data?.replies ?? [], live))
  const root = cachedRoot ?? page.data?.root
  return { root, replies, isPending: page.isPending && !root, isError: page.isError && !root }
}

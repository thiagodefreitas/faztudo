import { useQueries, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query"
import { api } from "../api/client"
import type { Approval, Attachment, Message, NoticeItem, OutputLine, ThreadPage } from "../types"
import { qk } from "./keys"
import { mergeApprovals, mergeById, mergeLanes } from "./merge"
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
    queryFn: async () => mergeLanes(await api.lanes(), qc.getQueryData(qk.lanes) ?? []),
  })
}

export function useOrg() {
  return useQuery({ queryKey: qk.org, queryFn: () => api.org() })
}

// The stored rolling summary of a channel. A failure means no catch-up line.
export function useChannelSummary(channelId: string, enabled = true) {
  return useQuery({
    queryKey: qk.summary(channelId),
    queryFn: () => api.channelSummary(channelId),
    enabled,
    retry: false,
    staleTime: 60_000,
  })
}

export function useRoutines() {
  return useQuery({ queryKey: qk.routines, queryFn: () => api.routines() })
}

// Every task. The stream keeps the cache current (see state/cache.ts).
export function useTasks() {
  const qc = useQueryClient()
  return useQuery({
    queryKey: qk.tasks,
    queryFn: async () => mergeById(await api.tasks(), qc.getQueryData(qk.tasks) ?? []),
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
    queryFn: async () => mergeApprovals(await api.approvals(), qc.getQueryData(qk.approvals) ?? []),
  })
}

function messagesQuery(qc: QueryClient, channelId: string) {
  return {
    queryKey: qk.messages(channelId),
    queryFn: async () => {
      const server = await api.messages(channelId, { limit: 100 })
      const local = qc.getQueryData<typeof server>(qk.messages(channelId)) ?? []
      return sortMessages(mergeById(server, local))
    },
  }
}

export function useMessages(channelId: string) {
  const qc = useQueryClient()
  return useQuery(messagesQuery(qc, channelId))
}

// The newest top-level message of each channel, for the inbox. It shares the
// cache of useMessages, so opening a channel afterwards costs no request.
export function useLastMessages(channelIds: string[]): Map<string, Message> {
  const qc = useQueryClient()
  const results = useQueries({ queries: channelIds.map((id) => messagesQuery(qc, id)) })
  const out = new Map<string, Message>()
  results.forEach((result, index) => {
    const last = result.data?.filter((message) => !message.thread_id).at(-1)
    const id = channelIds[index]
    if (last && id) out.set(id, last)
  })
  return out
}

// Every loaded top-level and thread message of the given channels, oldest
// channel first. It shares the caches of useMessages.
export function useAllMessages(channelIds: string[]): Message[] {
  const qc = useQueryClient()
  const results = useQueries({ queries: channelIds.map((id) => messagesQuery(qc, id)) })
  return results.flatMap((result) => result.data ?? [])
}

// The diff of a run, shared with the run panel's cache. Off until `enabled`.
export function useRunDiff(runId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: qk.diff(runId ?? ""),
    queryFn: () => api.diff(runId ?? ""),
    enabled: enabled && Boolean(runId),
    retry: false,
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
  /** Files already uploaded, kept so a retry sends them again. */
  attachments?: Attachment[]
  createdAt: string
  error?: string
}

// Pinned messages of a channel. Not the pinned agents of the inbox (lib/pins).
export function useChannelPins(channelId: string) {
  return useQuery({ queryKey: qk.messagePins(channelId), queryFn: () => api.pins(channelId) })
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

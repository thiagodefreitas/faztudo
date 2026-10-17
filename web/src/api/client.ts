import type {
  Approval,
  Channel,
  ChannelCreate,
  ChannelPatch,
  DiffPage,
  Health,
  ID,
  Lane,
  LanePatch,
  Member,
  Message,
  MessageCreate,
  OutputPage,
  ReadCursor,
  ReadResult,
  ResolveBody,
  RetryBody,
  Run,
  RunState,
  ThreadPage,
} from "../types"

// List endpoints are JSON arrays. Output is { lines }, diff is { diff },
// a thread is { root, replies }, and mark-read is { ok }. docs/api.md does
// not spell those envelopes out; see LANE_NOTES.md.

export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.code = code
  }
}

export interface Api {
  health: () => Promise<Health>
  me: () => Promise<Member>
  members: () => Promise<Member[]>
  channels: () => Promise<Channel[]>
  createChannel: (body: ChannelCreate) => Promise<Channel>
  patchChannel: (id: ID, body: ChannelPatch) => Promise<Channel>
  messages: (channelId: ID, query?: { before?: ID; limit?: number }) => Promise<Message[]>
  thread: (messageId: ID) => Promise<ThreadPage>
  postMessage: (channelId: ID, body: MessageCreate) => Promise<Message>
  markRead: (channelId: ID, body: ReadCursor) => Promise<ReadResult>
  runs: (query?: { channel_id?: ID; state?: RunState }) => Promise<Run[]>
  run: (id: ID) => Promise<Run>
  output: (id: ID, after?: number) => Promise<OutputPage>
  diff: (id: ID) => Promise<DiffPage>
  cancelRun: (id: ID) => Promise<Run>
  retryRun: (id: ID, body?: RetryBody) => Promise<Run>
  approvals: (state?: Approval["state"]) => Promise<Approval[]>
  resolveApproval: (id: ID, body: ResolveBody) => Promise<Approval>
  lanes: () => Promise<Lane[]>
  patchLane: (id: string, body: LanePatch) => Promise<Lane>
  probeLane: (id: string) => Promise<Lane>
}

export interface ApiOptions {
  fetch?: typeof fetch
  base?: string
}

export function createApi(options: ApiOptions = {}): Api {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis)
  const base = options.base ?? "/api/v1"

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await doFetch(`${base}${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    const data: unknown = text ? JSON.parse(text) : null
    if (!response.ok) {
      const record = data && typeof data === "object" ? (data as { error?: { code?: unknown; message?: unknown } }) : {}
      const code = typeof record.error?.code === "string" ? record.error.code : "internal"
      const message = typeof record.error?.message === "string" ? record.error.message : response.statusText
      throw new ApiError(response.status, code, message)
    }
    return data as T
  }

  function query(path: string, params: Record<string, string | number | undefined>): string {
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") search.set(key, String(value))
    }
    const text = search.toString()
    return text ? `${path}?${text}` : path
  }

  return {
    health: () => request("GET", "/health"),
    me: () => request("GET", "/me"),
    members: () => request("GET", "/members"),
    channels: () => request("GET", "/channels"),
    createChannel: (body) => request("POST", "/channels", body),
    patchChannel: (id, body) => request("PATCH", `/channels/${encodeURIComponent(id)}`, body),
    messages: (channelId, params = {}) =>
      request("GET", query(`/channels/${encodeURIComponent(channelId)}/messages`, params)),
    thread: (messageId) => request("GET", `/messages/${encodeURIComponent(messageId)}/thread`),
    postMessage: (channelId, body) => request("POST", `/channels/${encodeURIComponent(channelId)}/messages`, body),
    markRead: (channelId, body) => request("POST", `/channels/${encodeURIComponent(channelId)}/read`, body),
    runs: (params = {}) => request("GET", query("/runs", params)),
    run: (id) => request("GET", `/runs/${encodeURIComponent(id)}`),
    output: (id, after) => request("GET", query(`/runs/${encodeURIComponent(id)}/output`, { after })),
    diff: (id) => request("GET", `/runs/${encodeURIComponent(id)}/diff`),
    cancelRun: (id) => request("POST", `/runs/${encodeURIComponent(id)}/cancel`),
    retryRun: (id, body = {}) => request("POST", `/runs/${encodeURIComponent(id)}/retry`, body),
    approvals: (state) => request("GET", query("/approvals", { state })),
    resolveApproval: (id, body) => request("POST", `/approvals/${encodeURIComponent(id)}/resolve`, body),
    lanes: () => request("GET", "/lanes"),
    patchLane: (id, body) => request("PATCH", `/lanes/${encodeURIComponent(id)}`, body),
    probeLane: (id) => request("POST", `/lanes/${encodeURIComponent(id)}/probe`),
  }
}

export const api = createApi()

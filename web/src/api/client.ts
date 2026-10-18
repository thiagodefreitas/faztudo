import type {
  Approval,
  Attachment,
  AssignBody,
  AssignKind,
  CAInfo,
  Channel,
  ChannelCreate,
  ChannelPatch,
  ChannelSummary,
  CompareGroup,
  Device,
  DiffPage,
  Health,
  ID,
  Lane,
  LanePatch,
  LoginBody,
  Member,
  Message,
  MessageCreate,
  Org,
  OutputPage,
  PairBody,
  PairingTicket,
  Pin,
  Project,
  ProjectCreate,
  ProjectPatch,
  ReadCursor,
  ReadResult,
  ResolveBody,
  RetryBody,
  Routine,
  Run,
  RunState,
  SearchHit,
  Task,
  TaskInput,
  TaskPatch,
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
  search: (query: { q: string; channel_id?: ID; limit?: number }) => Promise<SearchHit[]>
  pins: (channelId: ID) => Promise<Pin[]>
  pinMessage: (messageId: ID) => Promise<{ pinned: boolean }>
  unpinMessage: (messageId: ID) => Promise<{ pinned: boolean }>
  uploadFile: (file: File) => Promise<Attachment>
  runs: (query?: { channel_id?: ID; state?: RunState }) => Promise<Run[]>
  run: (id: ID) => Promise<Run>
  output: (id: ID, after?: number) => Promise<OutputPage>
  diff: (id: ID) => Promise<DiffPage>
  cancelRun: (id: ID) => Promise<Run>
  retryRun: (id: ID, body?: RetryBody) => Promise<Run>
  approvals: (state?: Approval["state"]) => Promise<Approval[]>
  resolveApproval: (id: ID, body: ResolveBody) => Promise<Approval>
  compares: (channelId: ID) => Promise<CompareGroup[]>
  decideCompare: (channelId: ID, id: ID, decision: "merge_a" | "merge_b" | "discard_both" | "combine") => Promise<CompareGroup>
  org: () => Promise<Org>
  createProject: (body: ProjectCreate) => Promise<Project>
  patchProject: (handle: string, body: ProjectPatch) => Promise<Project>
  assign: (project: string, body: AssignBody) => Promise<Project>
  unassign: (project: string, kind: AssignKind, handle: string) => Promise<Project>
  routines: () => Promise<Routine[]>
  setRoutineEnabled: (handle: string, enabled: boolean) => Promise<Routine>
  runRoutine: (handle: string) => Promise<{ status: string }>
  tasks: (query?: { channel_id?: ID; project?: string }) => Promise<Task[]>
  createTask: (body: TaskInput) => Promise<Task>
  patchTask: (id: ID, body: TaskPatch) => Promise<Task>
  startTask: (id: ID) => Promise<Task>
  cancelTask: (id: ID) => Promise<Task>
  lanes: () => Promise<Lane[]>
  channelSummary: (channelId: ID) => Promise<ChannelSummary>
  patchLane: (id: string, body: LanePatch) => Promise<Lane>
  probeLane: (id: string) => Promise<Lane>
  login: (body: LoginBody) => Promise<Device>
  logout: () => Promise<ReadResult>
  devices: () => Promise<Device[]>
  revokeDevice: (id: ID) => Promise<ReadResult>
  createPairing: () => Promise<PairingTicket>
  pairDevice: (body: PairBody) => Promise<Device>
  caInfo: () => Promise<CAInfo>
}

export interface ApiOptions {
  fetch?: typeof fetch
  base?: string
}

export function createApi(options: ApiOptions = {}): Api {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis)
  const base = options.base ?? "/api/v1"

  // A FormData body is sent as is: the browser sets the multipart boundary.
  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const form = typeof FormData !== "undefined" && body instanceof FormData
    const response = await doFetch(`${base}${path}`, {
      method,
      credentials: "same-origin",
      headers: body === undefined || form ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : form ? (body as FormData) : JSON.stringify(body),
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
    search: (params) => request("GET", query("/search", params)),
    pins: (channelId) => request("GET", `/channels/${encodeURIComponent(channelId)}/pins`),
    pinMessage: (messageId) => request("POST", `/messages/${encodeURIComponent(messageId)}/pin`),
    unpinMessage: (messageId) => request("DELETE", `/messages/${encodeURIComponent(messageId)}/pin`),
    uploadFile: (file) => {
      const form = new FormData()
      form.append("file", file, file.name)
      return request("POST", "/files", form)
    },
    runs: (params = {}) => request("GET", query("/runs", params)),
    run: (id) => request("GET", `/runs/${encodeURIComponent(id)}`),
    output: (id, after) => request("GET", query(`/runs/${encodeURIComponent(id)}/output`, { after })),
    diff: (id) => request("GET", `/runs/${encodeURIComponent(id)}/diff`),
    cancelRun: (id) => request("POST", `/runs/${encodeURIComponent(id)}/cancel`),
    retryRun: (id, body = {}) => request("POST", `/runs/${encodeURIComponent(id)}/retry`, body),
    approvals: (state) => request("GET", query("/approvals", { state })),
    resolveApproval: (id, body) => request("POST", `/approvals/${encodeURIComponent(id)}/resolve`, body),
    compares: (channelId) => request("GET", `/channels/${encodeURIComponent(channelId)}/compares`),
    decideCompare: (channelId, id, decision) => request("POST", `/channels/${encodeURIComponent(channelId)}/compares/${encodeURIComponent(id)}/decide`, { decision }),
    org: () => request("GET", "/org"),
    createProject: (body) => request("POST", "/projects", body),
    patchProject: (handle, body) => request("PATCH", `/projects/${encodeURIComponent(handle)}`, body),
    assign: (project, body) => request("POST", `/projects/${encodeURIComponent(project)}/assignments`, body),
    unassign: (project, kind, handle) =>
      request("DELETE", `/projects/${encodeURIComponent(project)}/assignments/${kind}/${encodeURIComponent(handle)}`),
    routines: () => request("GET", "/routines"),
    setRoutineEnabled: (handle, enabled) => request("PATCH", `/routines/${encodeURIComponent(handle)}`, { enabled }),
    runRoutine: (handle) => request("POST", `/routines/${encodeURIComponent(handle)}/run`),
    tasks: (params = {}) => request("GET", query("/tasks", params)),
    createTask: (body) => request("POST", "/tasks", body),
    patchTask: (id, body) => request("PATCH", `/tasks/${encodeURIComponent(id)}`, body),
    startTask: (id) => request("POST", `/tasks/${encodeURIComponent(id)}/start`),
    cancelTask: (id) => request("POST", `/tasks/${encodeURIComponent(id)}/cancel`),
    lanes: () => request("GET", "/lanes"),
    channelSummary: (channelId) => request("GET", `/lanes/channel-summary/${encodeURIComponent(channelId)}`),
    patchLane: (id, body) => request("PATCH", `/lanes/${encodeURIComponent(id)}`, body),
    probeLane: (id) => request("POST", `/lanes/${encodeURIComponent(id)}/probe`),
    login: (body) => request("POST", "/auth/login", body),
    logout: () => request("POST", "/auth/logout"),
    devices: () => request("GET", "/auth/devices"),
    revokeDevice: (id) => request("DELETE", `/auth/devices/${encodeURIComponent(id)}`),
    createPairing: () => request("POST", "/auth/pairings"),
    pairDevice: (body) => request("POST", "/auth/pair", body),
    caInfo: () => request("GET", "/auth/ca"),
  }
}

/** The URL of a stored file. The name only sets the download file name. */
export function fileUrl(attachment: Pick<Attachment, "id" | "name">): string {
  return `/api/v1/files/${encodeURIComponent(attachment.id)}?name=${encodeURIComponent(attachment.name)}`
}

export const api = createApi()


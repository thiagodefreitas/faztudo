import { mentionHandles } from "../lib/mentions"
import { iso } from "../lib/time"
import { ulid } from "../lib/id"
import type {
  Approval,
  AssignBody,
  AssignKind,
  CAInfo,
  Channel,
  ChannelCreate,
  ChannelPatch,
  CompareGroup,
  Department,
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
  OutputLine,
  OutputPage,
  RunPrompt,
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
  RunMode,
  RunState,
  SearchHit,
  StreamEvent,
  Task,
  ThreadPage,
} from "../types"
import type { Clock } from "./clock"
import { IDS } from "./ids"
import { err, ok, type Result } from "./result"
import { APPROVAL_READY, FAIL_LINE, HELD_DETAIL, LIVE_PASS, MOCK_VERSION, SAMPLE_DIFF, SEED_PASS } from "./script"

interface Subscriber {
  after: number
  onEvent: (event: StreamEvent) => void
}

const TERMINAL = new Set<RunState>(["done", "failed", "cancelled"])
const REPO_ERROR = "repo_path is not a git work tree"

// The mock has no filesystem: an absolute path counts as a git work tree
// unless it ends in "not-a-repo".
function isMockGitPath(path: string): boolean {
  return path.startsWith("/") && !path.endsWith("not-a-repo")
}

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function terminal(state: RunState): boolean {
  return TERMINAL.has(state)
}

function byTime(a: { created_at: string; id: string }, b: { created_at: string; id: string }): number {
  return a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)
}

export class MockWorld {
  readonly me: Member
  private seq = 0
  private members: Member[]
  private channels: Channel[]
  private messages: Message[] = []
  private pinned = new Map<ID, string>()
  private runs: Run[] = []
  private approvals: Approval[] = []
  private compares: CompareGroup[] = []
  private lanes: Lane[]
  private outputs = new Map<string, OutputLine[]>()
  private outputSeq = new Map<string, number>()
  private diffs = new Map<string, string>()
  private log: StreamEvent[] = []
  private subs = new Set<Subscriber>()
  private timers = new Map<string, Array<() => void>>()
  private idempotency = new Map<string, Message>()
  private departments: Department[] = [
    { handle: "engineering", display_name: "Engineering", lead: "coder", members: ["coder", "reviewer"] },
  ]
  private projects: Project[] = [
    { handle: "faztudo", name: "Faztudo", channels: ["faztudo-dev"], departments: ["engineering"], specialists: [] },
  ]
  // The mock lists tasks for the board and project homes; it does not create
  // or run them.
  private tasks: Task[] = []
  private routines: Routine[] = [
    {
      handle: "daily-debrief",
      name: "Daily debrief",
      prompt: "",
      persona: "coder",
      channel: "general",
      schedule: "0 18 * * 1-5",
      template: "debrief",
      enabled: false,
    },
  ]

  constructor(private readonly clock: Clock) {
    const minute = 60_000
    const now = clock.now()
    this.me = {
      id: IDS.ada,
      kind: "human",
      handle: "ada",
      display_name: "Ada",
      presence: "online",
    }
    this.members = [
      this.me,
      {
        id: IDS.coder,
        kind: "agent",
        handle: "coder",
        display_name: "Coder",
        presence: "online",
        agent: { lanes: ["codex/default", "claude/opus"], role: "Implements changes in a worktree" },
      },
      {
        id: IDS.reviewer,
        kind: "agent",
        handle: "reviewer",
        display_name: "Reviewer",
        presence: "idle",
        agent: { lanes: ["claude/opus"], role: "Reviews diffs and plans" },
      },
      {
        id: IDS.claude,
        kind: "agent",
        handle: "claude",
        display_name: "Claude",
        presence: "offline",
        agent: { lanes: ["claude/opus"], role: "Claude Code on the opus lane" },
      },
    ]
    this.lanes = [
      {
        id: "codex/default",
        cli: "codex",
        cost_class: "standard",
        capacity: 2,
        running: 0,
        health: "available",
        windows: [
          {
            name: "5h",
            used_pct: 22,
            source: "cli-log",
            measured_at: iso(now - 12 * minute),
            resets_at: iso(now + 4 * 60 * minute),
          },
        ],
        runs_today: 3,
        tokens_last_hour: 1200,
      },
      {
        id: "claude/opus",
        cli: "claude",
        model: "opus",
        cost_class: "premium",
        capacity: 1,
        running: 0,
        health: "conserve",
        health_reason: "week window is above 80 percent",
        windows: [
          {
            name: "week",
            used_pct: 84,
            source: "probe",
            measured_at: iso(now - 2 * 60 * minute),
            resets_at: iso(now + 3 * 24 * 60 * minute),
          },
        ],
        runs_today: 1,
      },
      {
        id: "kimi/default",
        cli: "kimi",
        cost_class: "cheap",
        capacity: 1,
        running: 0,
        health: "unknown",
        windows: [{ name: "week", source: "unknown" }],
        runs_today: 0,
      },
      {
        id: "grok/default",
        cli: "grok",
        model: "grok-4",
        cost_class: "standard",
        capacity: 1,
        running: 0,
        health: "exhausted",
        health_reason: "5h window is used up",
        windows: [
          {
            name: "5h",
            used_pct: 100,
            source: "error",
            measured_at: iso(now - 5 * minute),
            resets_at: iso(now + 55 * minute),
          },
        ],
        runs_today: 4,
        tokens_last_hour: 31000,
        last_error: { class: "semantic", message: "usage limit reached, quota resets with the window", at: iso(now - 5 * minute) },
      },
      {
        id: "agy/default",
        cli: "agy",
        cost_class: "local",
        capacity: 1,
        running: 0,
        health: "unavailable",
        health_reason: "cli binary not found on PATH",
        windows: [
          {
            name: "day",
            used_pct: 12,
            source: "manual",
            measured_at: iso(now - 60 * minute),
            resets_at: iso(now + 8 * 60 * minute),
          },
        ],
        runs_today: 0,
      },
      {
        id: "opencode/default",
        cli: "opencode",
        cost_class: "cheap",
        capacity: 2,
        running: 1,
        health: "available",
        windows: [
          {
            name: "day",
            used_pct: 46,
            source: "cli-log",
            measured_at: iso(now - 18 * minute),
            resets_at: iso(now + 6 * 60 * minute),
          },
          {
            name: "week",
            used_pct: 61,
            source: "cli-log",
            measured_at: iso(now - 18 * minute),
            resets_at: iso(now + 3 * 24 * 60 * minute),
          },
          {
            name: "month",
            used_pct: 33,
            source: "probe",
            measured_at: iso(now - 40 * minute),
            resets_at: iso(now + 11 * 24 * 60 * minute),
          },
        ],
        runs_today: 7,
        tokens_last_hour: 8200,
      },
    ]
    const everyone = this.members.map((member) => member.id)
    this.channels = [
      {
        id: IDS.dev,
        name: "faztudo-dev",
        kind: "project",
        visibility: "public",
        topic: "Building the run card and approvals",
        repo_path: "/src/faztudo",
        test_command: "go test ./...",
        member_ids: everyone,
        unread: 0,
      },
      {
        id: IDS.general,
        name: "general",
        kind: "team",
        visibility: "public",
        topic: "Workspace-wide notes",
        member_ids: everyone,
        unread: 0,
      },
    ]
    this.seed(now)
  }

  subscribe(afterSeq: number, onEvent: (event: StreamEvent) => void): () => void {
    const sub: Subscriber = { after: afterSeq, onEvent }
    this.subs.add(sub)
    for (const event of this.log) {
      if (event.seq > afterSeq) onEvent(structuredClone(event))
    }
    return () => {
      this.subs.delete(sub)
    }
  }

  head(): number {
    return this.log.reduce((max, event) => Math.max(max, event.seq), 0)
  }

  health(): Health {
    return { ok: true, version: MOCK_VERSION }
  }

  getMe(): Member {
    return structuredClone(this.me)
  }

  getMembers(): Member[] {
    return structuredClone(this.members)
  }

  getChannels(): Channel[] {
    return structuredClone(this.channels)
  }

  // A fuller team for screenshots and demos (VITE_MOCK_SHOWCASE=1): every
  // agent CLI plus two more personas, one run working and one waiting for
  // an approval. Tests use the small default world.
  seedShowcase(): void {
    const minute = 60_000
    const now = this.clock.now()
    const agent = (handle: string, name: string, lanes: string[], role: string, presence: Member["presence"] = "offline"): Member => ({
      id: ulid(now),
      kind: "agent",
      handle,
      display_name: name,
      presence,
      agent: { lanes, role },
    })
    const added = [
      agent("architect", "Architect", ["claude/opus"], "Plans changes before anyone writes code", "busy"),
      agent("writer", "Writer", ["agy/default"], "Writes docs and release notes", "busy"),
      agent("codex", "Codex", ["codex/default"], "Codex CLI"),
      agent("grok", "Grok", ["grok/default"], "Grok CLI"),
      agent("kimi", "Kimi", ["kimi/default"], "Kimi CLI"),
      agent("agy", "Agy", ["agy/default"], "Antigravity CLI"),
      agent("opencode", "Opencode", ["opencode/default"], "OpenCode CLI"),
    ]
    this.members.push(...added)
    // The writer works on agy, so that lane has room in the showcase.
    const agy = this.lanes.find((lane) => lane.id === "agy/default")
    if (agy) {
      agy.health = "available"
      delete agy.health_reason
      agy.running = 1
      // The stream replays earlier lane events, so announce the change too.
      this.emit("lane.updated", undefined, agy, "system")
    }
    const dev = this.channels.find((channel) => channel.id === IDS.dev)
    if (dev) dev.member_ids = [...dev.member_ids, ...added.map((member) => member.id)]
    const [architect, writer] = added
    const working: Run = {
      id: ulid(now),
      trigger_message_id: IDS.msgHello,
      channel_id: IDS.dev,
      agent_id: writer!.id,
      lane_id: "agy/default",
      mode: "write",
      state: "running",
      started_at: iso(now - 3 * minute),
    }
    this.insertRun(working)
    const asking: Run = {
      id: ulid(now),
      trigger_message_id: IDS.msgHello,
      channel_id: IDS.dev,
      agent_id: architect!.id,
      lane_id: "claude/opus",
      mode: "read",
      state: "running",
      started_at: iso(now - 6 * minute),
    }
    this.insertRun(asking)
    this.requestApproval(asking.id)
    // A fuller organization for screenshots: Quality and Product next to
    // Engineering, all on the faztudo project.
    this.departments.push(
      { handle: "quality", display_name: "Quality", lead: "reviewer", members: ["reviewer"] },
      { handle: "product", display_name: "Product", lead: "architect", members: ["architect", "writer"] },
    )
    const project = this.projects.find((item) => item.handle === "faztudo")
    if (project) project.departments = [...new Set([...project.departments, "quality", "product"])]
    const task = (title: string, assignee: string, status: Task["status"], order: number, runIds: string[] = []): Task => ({
      id: ulid(now),
      channel_id: IDS.dev,
      title,
      assignee,
      mode: "write",
      scope: ["web/src/components/"],
      checks: ["npm test"],
      acceptance: [],
      status,
      order,
      run_ids: runIds,
      created_by: this.me.id,
      created_at: iso(now - (40 - order) * minute),
      updated_at: iso(now - (20 - order) * minute),
    })
    this.tasks = [
      task("Write the release notes for 0.1.0", "writer", "running", 1, [working.id]),
      task("Plan the Signal bridge", "architect", "review", 2, [asking.id]),
      task("Add day dividers to the chat", "coder", "done", 3),
      task("Show lane history on the dashboard", "coder", "todo", 4),
    ]
  }

  getTasks(channelId?: string, project?: string): Task[] {
    const channels = project ? (this.projects.find((item) => item.handle === project)?.channels ?? []) : null
    return structuredClone(
      this.tasks.filter((item) => {
        if (channelId && item.channel_id !== channelId) return false
        if (channels) {
          const name = this.channels.find((channel) => channel.id === item.channel_id)?.name
          return name !== undefined && channels.includes(name)
        }
        return true
      }),
    )
  }

  getLanes(): Lane[] {
    return structuredClone(this.lanes)
  }

  // The mock lists the organization and keeps assignments, but does not
  // refuse mentions in project channels the way the daemon does.
  getOrg(): Org {
    return structuredClone({ director_id: this.me.id, departments: this.departments, projects: this.projects })
  }

  // The mock checks what the daemon checks: a human handle, known agents and
  // departments, and a channel listed by one project at most.
  createProject(body: ProjectCreate): Result<Project> {
    const handle = (body.handle ?? "").trim()
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(handle)) return err(400, "bad_request", "handle: use letters, digits, - and _")
    if (this.projects.some((item) => item.handle.toLowerCase() === handle.toLowerCase())) {
      return err(409, "conflict", `a project with handle ${handle} exists`)
    }
    const project: Project = { handle, name: handle, channels: [], departments: [], specialists: [] }
    const problem = this.applyProject(project, body)
    if (problem) return err(400, "bad_request", problem)
    this.projects.push(project)
    this.emit("project.updated", undefined, project, `human:${this.me.id}`)
    return ok(structuredClone(project))
  }

  patchProject(handle: string, body: ProjectPatch): Result<Project> {
    const project = this.projects.find((item) => item.handle.toLowerCase() === handle.toLowerCase())
    if (!project) return err(404, "not_found", "resource not found")
    const problem = this.applyProject(project, body)
    if (problem) return err(400, "bad_request", problem)
    this.emit("project.updated", undefined, project, `human:${this.me.id}`)
    return ok(structuredClone(project))
  }

  private applyProject(project: Project, body: ProjectCreate | ProjectPatch): string | null {
    const dedupe = (list: string[]) => {
      const out: string[] = []
      for (const raw of list) {
        const item = raw.trim()
        if (item && !out.some((seen) => seen.toLowerCase() === item.toLowerCase())) out.push(item)
      }
      return out
    }
    const next: Project = { ...project }
    if (body.name !== undefined) next.name = body.name.trim() || project.handle
    if (body.repo_path !== undefined) next.repo_path = body.repo_path.trim() || undefined
    if (body.lead !== undefined) next.lead = body.lead.trim() || undefined
    if (body.channels !== undefined) next.channels = dedupe(body.channels)
    if ("departments" in body && body.departments !== undefined) next.departments = dedupe(body.departments)
    if ("specialists" in body && body.specialists !== undefined) next.specialists = dedupe(body.specialists)
    const agent = (handle: string) => this.members.some((item) => item.kind === "agent" && item.handle.toLowerCase() === handle.toLowerCase())
    if (next.lead && !agent(next.lead)) return `unknown lead ${next.lead}`
    for (const handle of next.departments) {
      if (!this.departments.some((item) => item.handle.toLowerCase() === handle.toLowerCase())) return `unknown department ${handle}`
    }
    for (const handle of next.specialists) if (!agent(handle)) return `unknown specialist ${handle}`
    for (const name of next.channels) {
      if (!NAME_RE.test(name)) return `invalid channel name ${name}`
      const other = this.projects.find(
        (item) => item.handle !== project.handle && item.channels.some((own) => own.toLowerCase() === name.toLowerCase()),
      )
      if (other) return `channel ${name} already belongs to project ${other.handle}`
    }
    if (next.repo_path && !isMockGitPath(next.repo_path)) return REPO_ERROR
    Object.assign(project, next)
    if (!next.repo_path) delete project.repo_path
    if (!next.lead) delete project.lead
    return null
  }

  assign(project: string, body: AssignBody): Result<Project> {
    const found = this.projects.find((item) => item.handle === project)
    if (!found) return err(404, "not_found", "resource not found")
    const known =
      body.kind === "department"
        ? this.departments.some((item) => item.handle === body.handle)
        : this.members.some((item) => item.kind === "agent" && item.handle === body.handle)
    if (!known) return err(400, "bad_request", `unknown ${body.kind} ${body.handle}`)
    const list = body.kind === "department" ? found.departments : found.specialists
    if (!list.includes(body.handle)) list.push(body.handle)
    this.emit("project.updated", undefined, found, `human:${this.me.id}`)
    return ok(structuredClone(found))
  }

  unassign(project: string, kind: AssignKind, handle: string): Result<Project> {
    const found = this.projects.find((item) => item.handle === project)
    if (!found) return err(404, "not_found", "resource not found")
    if (kind === "department") found.departments = found.departments.filter((item) => item !== handle)
    else found.specialists = found.specialists.filter((item) => item !== handle)
    this.emit("project.updated", undefined, found, `human:${this.me.id}`)
    return ok(structuredClone(found))
  }

  // The mock keeps the routines and their switch, but never runs one on a
  // schedule.
  getRoutines(): Routine[] {
    return structuredClone(this.routines)
  }

  getCompares(channelId: string): CompareGroup[] {
    return structuredClone(this.compares.filter((group) => group.channel_id === channelId).map((group) => ({
      ...group,
      candidates: group.candidates.map((candidate) => ({ ...candidate, run: this.runs.find((run) => run.id === candidate.run?.id) })) as CompareGroup["candidates"],
    })))
  }

  decideCompare(channelId: string, id: string, decision: "merge_a" | "merge_b" | "discard_both" | "combine"): Result<CompareGroup> {
    const group = this.compares.find((item) => item.id === id && item.channel_id === channelId)
    if (!group) return err(404, "not_found", "comparison not found")
    if (group.decision) return err(409, "conflict", "This comparison was already decided.")
    group.decision = decision
    if (decision === "merge_a" || decision === "merge_b") group.winner_lane = group.candidates[decision === "merge_a" ? 0 : 1].lane_id
    for (const candidate of group.candidates) {
      const run = this.runs.find((item) => item.id === candidate.run?.id)
      if (run) run.state = "done"
    }
    return ok(this.getCompares(channelId).find((item) => item.id === id) as CompareGroup)
  }

  setRoutineEnabled(handle: string, enabled: boolean): Result<Routine> {
    const found = this.routines.find((item) => item.handle === handle)
    if (!found) return err(404, "not_found", "resource not found")
    found.enabled = enabled
    this.emit("routine.updated", undefined, found, `human:${this.me.id}`)
    return ok(structuredClone(found))
  }

  runRoutine(handle: string): Result<{ status: string }> {
    const found = this.routines.find((item) => item.handle === handle)
    if (!found) return err(404, "not_found", "resource not found")
    found.last = { at: iso(this.clock.now()), status: "ok", detail: "Started from the mock." }
    this.emit("routine.updated", undefined, found, `human:${this.me.id}`)
    return ok({ status: "started" }, 202)
  }

  getMessages(channelId: ID, before?: ID, limit = 50): Result<Message[]> {
    const channel = this.channels.find((item) => item.id === channelId)
    if (!channel) return err(404, "not_found", "channel not found")
    if (!Number.isFinite(limit) || limit < 1) return err(400, "bad_request", "limit must be at least 1")
    const capped = Math.min(200, Math.floor(limit))
    const all = this.messages.filter((message) => message.channel_id === channelId && !message.thread_id).sort(byTime)
    let pool = all
    if (before) {
      const pivot = all.find((message) => message.id === before)
      if (!pivot) return err(400, "bad_request", "before is not a message in this channel")
      pool = all.filter((message) => byTime(message, pivot) < 0)
    }
    return ok(structuredClone(pool.slice(-capped)))
  }

  // Substring search over bodies, newest first. The real server ranks with
  // FTS5; the mock only needs the same shape and the same match markers.
  search(q: string, channelId?: ID): Result<SearchHit[]> {
    const words = q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
    if (words.length === 0) return ok([])
    const pattern = new RegExp(`(${words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "giu")
    const hits = this.messages
      .filter((message) => (!channelId || message.channel_id === channelId) && words.every((word) => message.body.toLowerCase().includes(word)))
      .sort(byTime)
      .reverse()
      .slice(0, 30)
    return ok(hits.map((message) => ({ message: structuredClone(message), snippet: message.body.replace(pattern, "\u0001$1\u0002") })))
  }

  getPins(channelId: ID): Result<Pin[]> {
    if (!this.channels.some((item) => item.id === channelId)) return err(404, "not_found", "channel not found")
    const pins: Pin[] = []
    for (const [messageId, at] of this.pinned) {
      const message = this.messages.find((item) => item.id === messageId)
      if (message && message.channel_id === channelId) {
        pins.push({ channel_id: channelId, message_id: messageId, pinned_by: this.me.id, pinned_at: at, message: structuredClone(message) })
      }
    }
    return ok(pins.sort((a, b) => b.pinned_at.localeCompare(a.pinned_at)))
  }

  setPin(messageId: ID, pinned: boolean): Result<{ pinned: boolean }> {
    const message = this.messages.find((item) => item.id === messageId)
    if (!message) return err(404, "not_found", "message not found")
    if (pinned === this.pinned.has(messageId)) return ok({ pinned })
    const at = iso(this.clock.now())
    if (pinned) this.pinned.set(messageId, at)
    else this.pinned.delete(messageId)
    this.emit(pinned ? "message.pinned" : "message.unpinned", message.channel_id, { channel_id: message.channel_id, message_id: messageId, pinned_by: this.me.id, pinned_at: at }, `human:${this.me.id}`)
    return ok({ pinned })
  }

  getThread(messageId: ID): Result<ThreadPage> {
    const message = this.messages.find((item) => item.id === messageId)
    if (!message) return err(404, "not_found", "message not found")
    const rootId = message.thread_id ?? message.id
    const root = this.messages.find((item) => item.id === rootId)
    if (!root) return err(404, "not_found", "message not found")
    const replies = this.messages.filter((item) => item.thread_id === root.id).sort(byTime)
    return ok({ root: structuredClone(root), replies: structuredClone(replies) })
  }

  getRuns(channelId?: ID, state?: RunState): Result<Run[]> {
    let list = this.runs
    if (channelId) list = list.filter((run) => run.channel_id === channelId)
    if (state) list = list.filter((run) => run.state === state)
    return ok(structuredClone(list))
  }

  getRun(id: ID): Result<Run> {
    const run = this.runs.find((item) => item.id === id)
    if (!run) return err(404, "not_found", "run not found")
    return ok(structuredClone(run))
  }

  getOutput(id: ID, after = 0): Result<OutputPage> {
    const run = this.runs.find((item) => item.id === id)
    if (!run) return err(404, "not_found", "run not found")
    if (!Number.isFinite(after) || after < 0) return err(400, "bad_request", "after must be a line seq")
    const lines = (this.outputs.get(id) ?? []).filter((line) => line.seq > after)
    return ok({ lines: structuredClone(lines) })
  }

  getPrompt(id: ID): Result<RunPrompt> {
    const run = this.runs.find((item) => item.id === id)
    if (!run) return err(404, "not_found", "run not found")
    const trigger = this.messages.find((item) => item.id === run.trigger_message_id)
    const parts = [
      { name: "transcript", text: "Recent channel messages (oldest first):\n" },
      { name: "request", text: `\nRequest:\n${trigger?.body ?? "Mock request"}` },
      { name: "instructions", text: "\n\nStart your answer with a summary of one or two plain sentences (no heading), then give the detail." },
    ]
    let offset = 0
    const sections = parts.map((part) => {
      const bytes = new TextEncoder().encode(part.text).length
      const section = { name: part.name, bytes, spans: [{ offset, bytes }] }
      offset += bytes
      return section
    })
    return ok({ run_id: id, prompt: parts.map((part) => part.text).join(""), sections })
  }

  getDiff(id: ID): Result<DiffPage> {
    const run = this.runs.find((item) => item.id === id)
    if (!run) return err(404, "not_found", "run not found")
    const diff = this.diffs.get(id)
    if (!diff) return err(404, "not_found", "diff not found")
    return ok({ diff })
  }

  getApprovals(state?: Approval["state"]): Approval[] {
    const list = state ? this.approvals.filter((item) => item.state === state) : this.approvals
    return structuredClone(list)
  }

  postMessage(channelId: ID, body: MessageCreate): Result<Message> {
    const channel = this.channels.find((item) => item.id === channelId)
    if (!channel) return err(404, "not_found", "channel not found")
    if (!body.body.trim()) return err(400, "bad_request", "body is empty")
    // Replies attach to the thread root, one level deep, as the server does.
    let rootId: ID | undefined
    if (body.thread_id) {
      const parent = this.messages.find((message) => message.id === body.thread_id && message.channel_id === channelId)
      if (!parent) return err(400, "bad_request", "invalid thread_id")
      rootId = parent.thread_id ?? parent.id
    }
    if (body.idempotency_key) {
      const existing = this.idempotency.get(body.idempotency_key)
      if (existing) return ok(structuredClone(existing))
    }
    const handles = mentionHandles(body.body)
    const mentions = handles
      .map((handle) => this.members.find((member) => member.handle === handle)?.id)
      .filter((id): id is ID => Boolean(id))
    const message: Message = {
      id: ulid(this.clock.now()),
      channel_id: channelId,
      ...(rootId ? { thread_id: rootId } : {}),
      author_id: this.me.id,
      body: body.body,
      mentions,
      created_at: iso(this.clock.now()),
    }
    this.addMessage(message)
    if (body.idempotency_key) this.idempotency.set(body.idempotency_key, message)
    this.emit("message.posted", channelId, message, `human:${this.me.id}`)
    const mentioned = handles
      .map((handle) => this.members.find((member) => member.kind === "agent" && member.handle === handle))
      .find((member): member is Member => Boolean(member))
    // A direct channel with exactly one agent needs no @mention.
    // A plain message (no mention, not a command) goes to the channel's default agent.
    const agent = mentioned ?? this.directAgent(channel) ?? (mentions.length === 0 && !body.body.trim().startsWith("/") ? this.defaultAgent(channel) : undefined)
    if (agent) this.startRun(channel, message, agent, /verify-fail/i.test(body.body) || agent.handle === "reviewer")
    return ok(structuredClone(message))
  }

  private defaultAgent(channel: Channel): Member | undefined {
    return this.members.find(
      (member) => member.kind === "agent" && member.id === channel.default_agent_id && channel.member_ids.includes(member.id),
    )
  }

  private directAgent(channel: Channel): Member | undefined {
    if (channel.kind !== "direct" && channel.visibility !== "direct") return undefined
    const agents = this.members.filter((member) => member.kind === "agent" && channel.member_ids.includes(member.id))
    return agents.length === 1 ? agents[0] : undefined
  }

  createChannel(body: ChannelCreate): Result<Channel> {
    if (!NAME_RE.test(body.name)) return err(400, "bad_request", "name must be lowercase words separated by dashes")
    if (body.repo_path && !isMockGitPath(body.repo_path)) return err(400, "bad_request", REPO_ERROR)
    if (this.channels.some((channel) => channel.name === body.name)) return err(409, "conflict", "channel name already used")
    const channel: Channel = {
      id: ulid(this.clock.now()),
      name: body.name,
      kind: body.kind,
      visibility: body.visibility,
      ...(body.topic ? { topic: body.topic } : {}),
      ...(body.repo_path ? { repo_path: body.repo_path } : {}),
      member_ids: body.member_ids ?? this.members.map((member) => member.id),
      unread: 0,
    }
    this.channels.push(channel)
    this.emit("channel.created", channel.id, channel, `human:${this.me.id}`)
    return ok(structuredClone(channel))
  }

  patchChannel(id: ID, body: ChannelPatch): Result<Channel> {
    const channel = this.channels.find((item) => item.id === id)
    if (!channel) return err(404, "not_found", "channel not found")
    if (body.name !== undefined) {
      if (!NAME_RE.test(body.name)) return err(400, "bad_request", "name must be lowercase words separated by dashes")
      channel.name = body.name
    }
    if (body.topic !== undefined) channel.topic = body.topic
    if (body.repo_path !== undefined) {
      if (body.repo_path !== "" && !isMockGitPath(body.repo_path)) return err(400, "bad_request", REPO_ERROR)
      channel.repo_path = body.repo_path || undefined
    }
    if (body.test_command !== undefined) channel.test_command = body.test_command || undefined
    if (body.member_ids !== undefined) channel.member_ids = body.member_ids
    if (body.default_agent_id !== undefined) {
      const agentId = body.default_agent_id
      const agent = this.members.find((member) => member.id === agentId && member.kind === "agent")
      if (agentId !== "" && !(agent && channel.member_ids.includes(agentId))) {
        return err(400, "bad_request", "default_agent_id must be an agent member of the channel")
      }
      channel.default_agent_id = agentId || undefined
    }
    this.emit("channel.updated", channel.id, channel, `human:${this.me.id}`)
    return ok(structuredClone(channel))
  }

  markRead(channelId: ID, body: ReadCursor): Result<ReadResult> {
    const channel = this.channels.find((item) => item.id === channelId)
    if (!channel) return err(404, "not_found", "channel not found")
    if (!body.seq || body.seq <= 0) return err(400, "bad_request", "seq is required")
    channel.unread = 0
    this.emit("channel.updated", channel.id, channel, `human:${this.me.id}`)
    return ok({ ok: true })
  }

  cancelRun(id: ID): Result<Run> {
    const run = this.runs.find((item) => item.id === id)
    if (!run) return err(404, "not_found", "run not found")
    if (terminal(run.state)) return err(409, "conflict", "run already finished")
    this.settle(id, { state: "cancelled" })
    const next = this.runs.find((item) => item.id === id)
    return next ? ok(structuredClone(next)) : err(404, "not_found", "run not found")
  }

  retryRun(id: ID, body: RetryBody = {}): Result<Run> {
    const run = this.runs.find((item) => item.id === id)
    if (!run) return err(404, "not_found", "run not found")
    if (!terminal(run.state)) return err(409, "conflict", "run is still going")
    const agent = this.members.find((member) => member.id === run.agent_id)
    if (!agent) return err(404, "not_found", "agent not found")
    const trigger = this.messages.find((message) => message.id === run.trigger_message_id)
    const channel = this.channels.find((item) => item.id === run.channel_id)
    if (!trigger || !channel) return err(404, "not_found", "trigger not found")
    const laneId = body.lane_id ?? run.lane_id
    if (body.lane_id && !(agent.agent?.lanes ?? []).includes(body.lane_id)) {
      return err(400, "bad_request", "lane is not on this agent")
    }
    for (const approval of this.approvals) {
      if (approval.run_id === id && approval.state === "pending") {
        approval.state = "expired"
        this.emit("approval.resolved", approval.channel_id, approval, "system")
      }
    }
    this.clearTimers(id)
    const restarted: Run = {
      ...run,
      lane_id: laneId,
      state: "queued",
      exit_code: undefined,
      failure_class: undefined,
      failure_reason: undefined,
      verification: undefined,
      diff_stat: undefined,
      ended_at: undefined,
      started_at: undefined,
    }
    delete restarted.exit_code
    delete restarted.failure_class
    delete restarted.failure_reason
    delete restarted.verification
    delete restarted.diff_stat
    delete restarted.ended_at
    delete restarted.started_at
    this.replaceRun(restarted)
    this.diffs.delete(id)
    this.outputs.set(id, [])
    this.outputSeq.set(id, 0)
    this.emit("run.updated", restarted.channel_id, restarted, `agent:${agent.id}`)
    if (laneId !== run.lane_id) {
      this.emit(
        "lane.switched",
        restarted.channel_id,
        { run_id: id, from: run.lane_id, to: laneId, reason: "retry requested" },
        "system",
      )
    }
    this.acquire(laneId)
    this.script(id, /verify-fail/i.test(trigger.body) || agent.handle === "reviewer" ? "fail" : "approval", laneId)
    const next = this.runs.find((item) => item.id === id)
    return next ? ok(structuredClone(next)) : err(404, "not_found", "run not found")
  }

  resolveApproval(id: ID, body: ResolveBody): Result<Approval> {
    const approval = this.approvals.find((item) => item.id === id)
    if (!approval) return err(404, "not_found", "approval not found")
    if (approval.state !== "pending") return err(409, "conflict", "approval is not pending")
    const option = approval.options.find((item) => item.key === body.option)
    if (!option) return err(400, "bad_request", "unknown option")
    approval.state = "resolved"
    approval.resolution = {
      option: option.key,
      by: this.me.id,
      at: iso(this.clock.now()),
      ...(body.note ? { note: body.note } : {}),
    }
    this.emit("approval.resolved", approval.channel_id, approval, `human:${this.me.id}`)
    if (approval.run_id) {
      if (option.key === "drop" || option.style === "danger") this.settle(approval.run_id, { state: "cancelled" })
      else if (option.key === "hold") {
        this.settle(approval.run_id, {
          state: "done",
          exit_code: 0,
          verification: { ok: true, detail: HELD_DETAIL },
        })
      } else this.continueAfterPush(approval.run_id)
    }
    return ok(structuredClone(approval))
  }

  patchLane(id: string, body: LanePatch): Result<Lane> {
    const lane = this.lanes.find((item) => item.id === id)
    if (!lane) return err(404, "not_found", "lane not found")
    if (body.capacity !== undefined) {
      if (!Number.isFinite(body.capacity) || body.capacity < 0) return err(400, "bad_request", "capacity must be >= 0")
      lane.capacity = body.capacity
    }
    if (body.health_override) {
      lane.health = body.health_override
      lane.health_reason = "manual override"
    }
    if (body.manual_window) {
      const window = {
        name: body.manual_window.name,
        ...(body.manual_window.used_pct !== undefined ? { used_pct: body.manual_window.used_pct } : {}),
        ...(body.manual_window.resets_at ? { resets_at: body.manual_window.resets_at } : {}),
        source: "manual" as const,
        measured_at: iso(this.clock.now()),
      }
      const index = lane.windows.findIndex((item) => item.name === window.name)
      if (index === -1) lane.windows.push(window)
      else lane.windows[index] = window
    }
    this.emit("lane.updated", undefined, lane, "system")
    return ok(structuredClone(lane))
  }

  probeLane(id: string): Result<Lane> {
    const lane = this.lanes.find((item) => item.id === id)
    if (!lane) return err(404, "not_found", "lane not found")
    const measured = iso(this.clock.now())
    lane.windows = lane.windows.map((window) => ({ ...window, source: "probe", measured_at: measured }))
    this.emit("lane.updated", undefined, lane, "system")
    return ok(structuredClone(lane))
  }

  private devicesList: Device[] = [
    {
      id: "01BRZ3NDEKTSV4RRFFQ69G5DEV",
      device_name: "Pixel 9",
      user_agent: "Mozilla/5.0 (Linux; Android 15; Pixel 9)",
      created_at: "2026-04-17T10:00:00Z",
      last_seen_at: "2026-04-17T10:05:00Z",
      current: false,
    },
  ]
  private pairingTokens = new Set<string>(["0123456789abcdef0123456789abcdef"])

  login(body: LoginBody): Result<Device> {
    if (!body.password || body.password === "wrong") {
      return err(401, "unauthorized", "invalid password")
    }
    const dev: Device = {
      id: ulid(this.clock.now()),
      device_name: body.device_name?.trim() || "Browser",
      user_agent: "MockBrowser/1.0",
      created_at: iso(this.clock.now()),
      last_seen_at: iso(this.clock.now()),
      current: true,
      ok: true,
    }
    this.devicesList.unshift(dev)
    return ok(structuredClone(dev))
  }

  logout(): Result<ReadResult> {
    return ok({ ok: true })
  }

  getDevices(): Device[] {
    return structuredClone(this.devicesList)
  }

  revokeDevice(id: ID): Result<ReadResult> {
    const idx = this.devicesList.findIndex((item) => item.id === id)
    if (idx === -1) return err(404, "not_found", "device not found")
    this.devicesList.splice(idx, 1)
    return ok({ ok: true })
  }

  createPairing(): Result<PairingTicket> {
    const token = "fedcba9876543210fedcba9876543210" // gitleaks:allow (synthetic test token)
    this.pairingTokens.add(token)
    return ok({
      token,
      url: `https://192.168.1.10:7458/pair#${token}`,
      qr_svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 29 29" role="img" aria-label="QR code"><rect width="29" height="29" fill="#ffffff"/><path d="M4 4h7v7H4z" fill="#000000"/></svg>`,
      ca_fingerprint: "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99",
      ca_http_url: "http://192.168.1.10:7459",
      expires_at: iso(this.clock.now() + 5 * 60_000),
    })
  }

  pairDevice(body: PairBody): Result<Device> {
    const tok = body.token.trim()
    const valid = this.pairingTokens.has(tok)
    this.pairingTokens.delete(tok)
    if (!tok) return err(400, "bad_request", "token required")
    if (!body.device_name.trim()) return err(400, "bad_request", "device_name required")
    if (!valid) return err(401, "unauthorized", "invalid or expired pairing token")
    const dev: Device = {
      id: ulid(this.clock.now()),
      device_name: body.device_name.trim(),
      user_agent: "MockPhone/1.0",
      created_at: iso(this.clock.now()),
      last_seen_at: iso(this.clock.now()),
      current: true,
      ok: true,
    }
    this.devicesList.unshift(dev)
    return ok(structuredClone(dev))
  }

  caInfo(): CAInfo {
    return {
      ca_fingerprint: "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99",
      ca_http_url: "http://192.168.1.10:7459",
      lan_urls: ["https://192.168.1.10:7458"],
    }
  }

  private seed(now: number): void {
    const minute = 60_000
    for (const member of this.members) this.emit("member.updated", undefined, member, "system")
    for (const lane of this.lanes) this.emit("lane.updated", undefined, lane, "system")
    for (const channel of this.channels) this.emit("channel.created", channel.id, channel, "system")

    this.insertMessage({
      id: IDS.msgHello,
      channel_id: IDS.dev,
      author_id: IDS.ada,
      body: "The run card needs the verification result in the channel, with the failing output when it fails.",
      mentions: [],
      created_at: iso(now - 40 * minute),
    })
    this.insertRun({
      id: IDS.runPass,
      channel_id: IDS.dev,
      trigger_message_id: IDS.msgHello,
      agent_id: IDS.coder,
      lane_id: "codex/default",
      mode: "write",
      state: "done",
      worktree: `/worktrees/fz/${IDS.runPass}`,
      started_at: iso(now - 30 * minute),
      ended_at: iso(now - 28 * minute),
      exit_code: 0,
      verification: { ok: true, detail: SEED_PASS },
      diff_stat: { files: 1, insertions: 2, deletions: 1 },
    })
    this.diffs.set(IDS.runPass, SAMPLE_DIFF)
    this.seedOutput(IDS.runPass, [
      { stream: "stdout", text: "editing the run card\n" },
      { stream: "stdout", text: "verification passed\n" },
    ])
    this.insertMessage({
      id: IDS.msgPass,
      channel_id: IDS.dev,
      author_id: IDS.coder,
      body: "Updated the run card.",
      mentions: [],
      run_id: IDS.runPass,
      created_at: iso(now - 30 * minute),
    })

    this.insertRun({
      id: IDS.runFail,
      channel_id: IDS.dev,
      trigger_message_id: IDS.msgHello,
      agent_id: IDS.reviewer,
      lane_id: "claude/opus",
      mode: "read",
      state: "failed",
      started_at: iso(now - 12 * minute),
      ended_at: iso(now - 11 * minute),
      exit_code: 1,
      failure_class: "semantic",
      failure_reason: "verification failed",
      verification: {
        ok: false,
        detail: `go test ./...\n--- FAIL: TestLaneHealth (0.02s)\n    health_test.go:42: ${FAIL_LINE}\nFAIL`,
      },
    })
    this.seedOutput(IDS.runFail, [
      { stream: "stdout", text: "running go test ./...\n" },
      { stream: "stderr", text: `    health_test.go:42: ${FAIL_LINE}\n` },
    ])
    this.insertMessage({
      id: IDS.msgFail,
      channel_id: IDS.dev,
      author_id: IDS.reviewer,
      body: "Verification failed.",
      mentions: [],
      run_id: IDS.runFail,
      created_at: iso(now - 12 * minute),
    })

    this.insertMessage({ id: IDS.msgCompare, channel_id: IDS.dev, author_id: IDS.ada, body: "@coder x2 Make the run card clearer", mentions: [IDS.coder], created_at: iso(now - 4 * minute) })
    const compareA: Run = { id: IDS.runCompareA, channel_id: IDS.dev, trigger_message_id: IDS.msgCompare, agent_id: IDS.coder, lane_id: "codex/default", mode: "write", state: "waiting_approval", worktree: `/worktrees/fz/${IDS.runCompareA}`, verification: { ok: true, detail: "npm test passed" }, diff_stat: { files: 2, insertions: 14, deletions: 3 } }
    const compareB: Run = { id: IDS.runCompareB, channel_id: IDS.dev, trigger_message_id: IDS.msgCompare, agent_id: IDS.coder, lane_id: "claude/opus", mode: "write", state: "waiting_approval", worktree: `/worktrees/fz/${IDS.runCompareB}`, verification: { ok: true, detail: "npm test passed" }, diff_stat: { files: 1, insertions: 9, deletions: 2 } }
    this.insertRun(compareA)
    this.insertRun(compareB)
    this.seedOutput(compareA.id, [{ stream: "stdout", text: "candidate A: tests passed\n" }])
    this.seedOutput(compareB.id, [{ stream: "stdout", text: "candidate B: tests passed\n" }])
    this.compares.push({ id: "compare-showcase", channel_id: IDS.dev, message_id: IDS.msgCompare, agent_id: IDS.coder, candidates: [{ lane_id: compareA.lane_id, run: compareA, output_tail: ["candidate A: tests passed"] }, { lane_id: compareB.lane_id, run: compareB, output_tail: ["candidate B: tests passed"] }] })

    this.insertMessage({
      id: IDS.msgGen1,
      channel_id: IDS.general,
      author_id: IDS.ada,
      body: "Notes for the week live in this channel.",
      mentions: [],
      created_at: iso(now - 3 * 60 * minute),
    })
    this.insertMessage({
      id: IDS.msgGen2,
      channel_id: IDS.general,
      author_id: IDS.ada,
      body: "Lane health stays on the run card until the dashboard exists.",
      mentions: [],
      created_at: iso(now - 2 * 60 * minute),
    })
    this.insertMessage({
      id: IDS.msgAsk,
      channel_id: IDS.general,
      author_id: IDS.coder,
      body: "@ada which test command should the lane use?",
      mentions: [IDS.ada],
      options: ["go test ./...", "make check", "Skip verification"],
      created_at: iso(now - 90 * minute),
    })
    this.insertMessage({
      id: IDS.msgAgents,
      channel_id: IDS.general,
      author_id: IDS.coder,
      body: "@reviewer the lane health patch is ready for a look.",
      mentions: [IDS.reviewer],
      created_at: iso(now - 80 * minute),
    })
    const general = this.channels.find((channel) => channel.id === IDS.general)
    if (general) {
      general.unread = 2
      this.emit("channel.updated", general.id, general, "system")
    }
  }

  // Stores a message and keeps the root's reply_count, as the server does.
  private addMessage(message: Message): void {
    this.messages.push(message)
    if (!message.thread_id) return
    const root = this.messages.find((item) => item.id === message.thread_id)
    if (root) root.reply_count = (root.reply_count ?? 0) + 1
  }

  private insertMessage(message: Message): void {
    this.addMessage(message)
    const author = this.members.find((member) => member.id === message.author_id)
    const actor = author?.kind === "agent" ? `agent:${author.id}` : `human:${message.author_id}`
    this.emit("message.posted", message.channel_id, message, actor)
  }

  private insertRun(run: Run): void {
    this.runs.push(run)
    this.emit("run.created", run.channel_id, run, `agent:${run.agent_id}`)
  }

  private seedOutput(runId: ID, lines: Array<{ stream: "stdout" | "stderr"; text: string }>): void {
    for (const line of lines) this.appendOutput(runId, line.stream, line.text)
  }

  private startRun(channel: Channel, trigger: Message, agent: Member, fail: boolean): void {
    const picked = this.pickLane(agent)
    const mode: RunMode = agent.handle === "reviewer" || fail ? "read" : "write"
    const run: Run = {
      id: ulid(this.clock.now()),
      channel_id: channel.id,
      trigger_message_id: trigger.id,
      agent_id: agent.id,
      lane_id: picked.laneId,
      mode,
      state: "queued",
      ...(mode === "write" ? { worktree: `/worktrees/fz/pending` } : {}),
    }
    this.runs.push(run)
    this.emit("run.created", channel.id, run, `agent:${agent.id}`)
    if (picked.from && picked.reason) {
      this.emit(
        "lane.switched",
        channel.id,
        { run_id: run.id, from: picked.from, to: picked.laneId, reason: picked.reason },
        "system",
      )
    }
    this.acquire(picked.laneId)
    const followup: Message = {
      id: ulid(this.clock.now()),
      channel_id: channel.id,
      ...(trigger.thread_id ? { thread_id: trigger.thread_id } : {}),
      author_id: agent.id,
      body: mode === "write" ? "Started a write run." : "Started a read run.",
      mentions: [],
      run_id: run.id,
      created_at: iso(this.clock.now()),
    }
    this.addMessage(followup)
    this.emit("message.posted", channel.id, followup, `agent:${agent.id}`)
    this.bumpUnread(channel.id)
    this.script(run.id, fail ? "fail" : "approval", picked.laneId)
  }

  private pickLane(agent: Member): { laneId: string; from?: string; reason?: string } {
    const chain = agent.agent?.lanes ?? []
    if (chain.length === 0) return { laneId: "unknown" }
    const usable = (id: string) => {
      const lane = this.lanes.find((item) => item.id === id)
      if (!lane) return false
      if (lane.health === "exhausted" || lane.health === "unavailable") return false
      return lane.running < lane.capacity
    }
    const first = chain[0] ?? "unknown"
    if (usable(first)) return { laneId: first }
    const next = chain.find((id) => usable(id))
    if (!next) return { laneId: first }
    const skipped = this.lanes.find((lane) => lane.id === first)
    const reason =
      skipped && (skipped.health === "exhausted" || skipped.health === "unavailable")
        ? `skipped ${first} (${skipped.health})`
        : `skipped ${first} (no capacity)`
    return { laneId: next, from: first, reason }
  }

  private script(runId: ID, kind: "approval" | "fail", laneId: string): void {
    this.later(runId, 200, () => {
      const run = this.runs.find((item) => item.id === runId)
      if (!run || terminal(run.state)) return
      const started: Run = {
        ...run,
        state: "running",
        started_at: iso(this.clock.now()),
        ...(run.mode === "write" ? { worktree: `/worktrees/fz/${runId}` } : {}),
      }
      this.replaceRun(started)
      this.emit("run.updated", started.channel_id, started, `agent:${started.agent_id}`)
    })
    const lines =
      kind === "approval"
        ? [
            { stream: "stdout" as const, text: "reading the channel\n" },
            { stream: "stdout" as const, text: `using lane ${laneId}\n` },
            { stream: "stdout" as const, text: "editing the run card\n" },
            { stream: "stderr" as const, text: "note: tests not run yet\n" },
            { stream: "stdout" as const, text: `${APPROVAL_READY}\n` },
          ]
        : [
            { stream: "stdout" as const, text: "running go test ./...\n" },
            { stream: "stderr" as const, text: "--- FAIL: TestLaneHealth\n" },
            { stream: "stderr" as const, text: `    health_test.go:42: ${FAIL_LINE}\n` },
            { stream: "stderr" as const, text: "FAIL\n" },
          ]
    lines.forEach((line, index) => {
      this.later(runId, 600 + index * 400, () => {
        const run = this.runs.find((item) => item.id === runId)
        if (!run || terminal(run.state) || run.state === "waiting_approval") return
        this.appendOutput(runId, line.stream, line.text)
      })
    })
    const doneAt = 600 + lines.length * 400
    if (kind === "approval") {
      this.later(runId, doneAt, () => this.requestApproval(runId))
    } else {
      this.later(runId, doneAt, () => {
        this.settle(runId, {
          state: "failed",
          exit_code: 1,
          failure_class: "semantic",
          failure_reason: "verification failed",
          verification: {
            ok: false,
            detail: `go test ./...\n--- FAIL: TestLaneHealth (0.02s)\n    health_test.go:42: ${FAIL_LINE}\nFAIL`,
          },
        })
      })
    }
  }

  private requestApproval(runId: ID): void {
    const run = this.runs.find((item) => item.id === runId)
    if (!run || terminal(run.state)) return
    const waiting: Run = { ...run, state: "waiting_approval" }
    this.replaceRun(waiting)
    this.emit("run.updated", waiting.channel_id, waiting, `agent:${waiting.agent_id}`)
    const approval: Approval = {
      id: ulid(this.clock.now()),
      run_id: runId,
      channel_id: run.channel_id,
      requested_by: run.agent_id,
      title: `Push branch fz/run-${runId.slice(-6).toLowerCase()} to origin`,
      detail: ["Push the branch to origin.", "", "```", "git push origin HEAD", "```", "", "Nothing leaves this machine until you answer."].join(
        "\n",
      ),
      options: [
        { key: "push", label: "Push", style: "primary" },
        { key: "hold", label: "Hold" },
        { key: "drop", label: "Drop", style: "danger" },
      ],
      state: "pending",
    }
    this.approvals.push(approval)
    this.emit("approval.requested", run.channel_id, approval, `agent:${run.agent_id}`)
  }

  private continueAfterPush(runId: ID): void {
    const run = this.runs.find((item) => item.id === runId)
    if (!run || terminal(run.state)) return
    const verifying: Run = { ...run, state: "verifying" }
    this.replaceRun(verifying)
    this.emit("run.updated", verifying.channel_id, verifying, `agent:${verifying.agent_id}`)
    this.appendOutput(runId, "stdout", "running go test ./...\n")
    this.later(runId, 700, () => {
      this.diffs.set(runId, SAMPLE_DIFF)
      this.settle(runId, {
        state: "done",
        exit_code: 0,
        verification: { ok: true, detail: LIVE_PASS },
        diff_stat: { files: 1, insertions: 2, deletions: 1 },
      })
    })
  }

  private settle(runId: ID, patch: Partial<Run>): void {
    const current = this.runs.find((item) => item.id === runId)
    if (!current || terminal(current.state)) return
    this.clearTimers(runId)
    const next: Run = { ...current, ...patch, ended_at: iso(this.clock.now()) }
    this.replaceRun(next)
    this.emit("run.updated", next.channel_id, next, `agent:${next.agent_id}`)
    this.release(current.lane_id)
  }

  private acquire(laneId: string): void {
    const lane = this.lanes.find((item) => item.id === laneId)
    if (!lane) return
    lane.running += 1
    lane.runs_today += 1
    this.emit("lane.updated", undefined, lane, "system")
  }

  private release(laneId: string): void {
    const lane = this.lanes.find((item) => item.id === laneId)
    if (!lane) return
    lane.running = Math.max(0, lane.running - 1)
    this.emit("lane.updated", undefined, lane, "system")
  }

  private bumpUnread(channelId: ID): void {
    const channel = this.channels.find((item) => item.id === channelId)
    if (!channel) return
    channel.unread += 1
    this.emit("channel.updated", channel.id, channel, "system")
  }

  private appendOutput(runId: ID, stream: "stdout" | "stderr", text: string): void {
    const seq = (this.outputSeq.get(runId) ?? 0) + 1
    this.outputSeq.set(runId, seq)
    const line: OutputLine = { seq, stream, text }
    const list = this.outputs.get(runId) ?? []
    list.push(line)
    this.outputs.set(runId, list)
    const run = this.runs.find((item) => item.id === runId)
    this.emit("run.output", run?.channel_id, { run_id: runId, ...line }, run ? `agent:${run.agent_id}` : "system")
  }

  private replaceRun(run: Run): void {
    const index = this.runs.findIndex((item) => item.id === run.id)
    if (index === -1) this.runs.push(run)
    else this.runs[index] = run
  }

  private later(runId: ID, ms: number, fn: () => void): void {
    const cancel = this.clock.schedule(fn, ms)
    const list = this.timers.get(runId) ?? []
    list.push(cancel)
    this.timers.set(runId, list)
  }

  private clearTimers(runId: ID): void {
    for (const cancel of this.timers.get(runId) ?? []) cancel()
    this.timers.delete(runId)
  }

  private emit(type: StreamEvent["type"], channelId: ID | undefined, payload: unknown, actor: string): StreamEvent {
    const id = ulid(this.clock.now())
    const seq = ++this.seq
    if (channelId) {
      const channel = this.channels.find((item) => item.id === channelId)
      if (channel) channel.last_seq = seq
    }
    const event: StreamEvent = {
      seq,
      id,
      version: 1,
      type,
      actor,
      ...(channelId ? { channel_id: channelId } : {}),
      ts: iso(this.clock.now()),
      payload: structuredClone(payload),
    }
    this.log.push(event)
    for (const sub of this.subs) {
      if (event.seq > sub.after) sub.onEvent(structuredClone(event))
    }
    return event
  }
}

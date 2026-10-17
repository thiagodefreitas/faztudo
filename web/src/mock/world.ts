import { mentionHandles } from "../lib/mentions"
import { iso } from "../lib/time"
import { ulid } from "../lib/id"
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
  OutputLine,
  OutputPage,
  ReadCursor,
  ReadResult,
  ResolveBody,
  RetryBody,
  Run,
  RunMode,
  RunState,
  StreamEvent,
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
  private runs: Run[] = []
  private approvals: Approval[] = []
  private lanes: Lane[]
  private outputs = new Map<string, OutputLine[]>()
  private outputSeq = new Map<string, number>()
  private diffs = new Map<string, string>()
  private log: StreamEvent[] = []
  private subs = new Set<Subscriber>()
  private timers = new Map<string, Array<() => void>>()
  private idempotency = new Map<string, Message>()

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

  getLanes(): Lane[] {
    return structuredClone(this.lanes)
  }

  getMessages(channelId: ID, before?: ID, limit = 50): Result<Message[]> {
    const channel = this.channels.find((item) => item.id === channelId)
    if (!channel) return err(404, "not_found", "channel not found")
    if (!Number.isFinite(limit) || limit < 1) return err(400, "bad_request", "limit must be at least 1")
    const capped = Math.min(200, Math.floor(limit))
    const all = this.messages.filter((message) => message.channel_id === channelId).sort(byTime)
    let pool = all
    if (before) {
      const pivot = all.find((message) => message.id === before)
      if (!pivot) return err(400, "bad_request", "before is not a message in this channel")
      pool = all.filter((message) => byTime(message, pivot) < 0)
    }
    return ok(structuredClone(pool.slice(-capped)))
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
    if (body.thread_id && !this.messages.some((message) => message.id === body.thread_id)) {
      return err(400, "bad_request", "thread not found")
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
      ...(body.thread_id ? { thread_id: body.thread_id } : {}),
      author_id: this.me.id,
      body: body.body,
      mentions,
      created_at: iso(this.clock.now()),
    }
    this.messages.push(message)
    if (body.idempotency_key) this.idempotency.set(body.idempotency_key, message)
    this.emit("message.posted", channelId, message, `human:${this.me.id}`)
    const agent = handles
      .map((handle) => this.members.find((member) => member.kind === "agent" && member.handle === handle))
      .find((member): member is Member => Boolean(member))
    if (agent) this.startRun(channel, message, agent, /verify-fail/i.test(body.body) || agent.handle === "reviewer")
    return ok(structuredClone(message))
  }

  createChannel(body: ChannelCreate): Result<Channel> {
    if (!NAME_RE.test(body.name)) return err(400, "bad_request", "name must be lowercase words separated by dashes")
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
    if (body.repo_path !== undefined) channel.repo_path = body.repo_path
    if (body.member_ids !== undefined) channel.member_ids = body.member_ids
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
    const general = this.channels.find((channel) => channel.id === IDS.general)
    if (general) {
      general.unread = 2
      this.emit("channel.updated", general.id, general, "system")
    }
  }

  private insertMessage(message: Message): void {
    this.messages.push(message)
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
      author_id: agent.id,
      body: mode === "write" ? "Started a write run." : "Started a read run.",
      mentions: [],
      run_id: run.id,
      created_at: iso(this.clock.now()),
    }
    this.messages.push(followup)
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

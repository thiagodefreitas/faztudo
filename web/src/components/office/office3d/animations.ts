import type { ID, Member, Run, StreamEvent } from "../../../types"

export const HANDOFF_DURATION_MS = 2600
export const MERGE_POP_DURATION_MS = 1800

export interface HandoffAnimation {
  id: string
  kind: "handoff"
  dedupeKey: string
  fromMemberId: ID
  toMemberId: ID
  fromHandle: string
  toHandle: string
  startedAt: number
  endsAt: number
  durationMs: number
}

export interface MergeAnimation {
  id: string
  kind: "merge"
  dedupeKey: string
  memberId: ID
  runId?: ID | undefined
  startedAt: number
  endsAt: number
  durationMs: number
}

export type OfficeAnimation = HandoffAnimation | MergeAnimation

export interface OfficeAnimationQueue {
  items: OfficeAnimation[]
  seenKeys: string[]
}

export interface EnqueueContext {
  members: readonly Member[]
  runs?: readonly Run[] | undefined
  now: number
}

export function createAnimationQueue(initial: OfficeAnimation[] = []): OfficeAnimationQueue {
  return {
    items: [...initial],
    seenKeys: initial.map((item) => item.dedupeKey),
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null
}

function cleanHandle(raw: string): string {
  return raw.trim().replace(/^@+/, "").toLowerCase()
}

export function resolveMemberByRef(members: readonly Member[], ref: string | null | undefined): Member | null {
  if (!ref) return null
  const byId = members.find((m) => m.id === ref)
  if (byId) return byId
  const normalized = cleanHandle(ref)
  return members.find((m) => cleanHandle(m.handle) === normalized) ?? null
}

function parseHandoffPayload(event: StreamEvent): {
  from: string
  to: string
  requestId: string
  depth: number
  messageId: string
} | null {
  const payload = asRecord(event.payload)
  if (!payload) return null

  if (event.type === "handoff.created" || event.type === "message.handoff") {
    const nested = asRecord(payload.handoff)
    const source = nested ?? payload
    const from = asText(source.from)
    const to = asText(source.to)
    if (!from || !to) return null
    const requestId = asText(source.request_id) ?? asText(payload.request_id) ?? event.id
    const depth = typeof source.depth === "number" ? source.depth : 1
    const messageId = asText(payload.message_id) ?? asText(payload.id) ?? event.id
    return { from, to, requestId, depth, messageId }
  }

  if (event.type === "message.posted") {
    const handoff = asRecord(payload.handoff)
    if (!handoff) return null
    const from = asText(handoff.from) ?? asText(payload.author_id)
    const to = asText(handoff.to)
    if (!from || !to) return null
    const requestId = asText(handoff.request_id) ?? asText(payload.id) ?? event.id
    const depth = typeof handoff.depth === "number" ? handoff.depth : 1
    const messageId = asText(payload.id) ?? event.id
    return { from, to, requestId, depth, messageId }
  }

  return null
}

function parseMergePayload(
  event: StreamEvent,
  members: readonly Member[],
  runs: readonly Run[],
): { memberId: ID; runId?: ID | undefined; dedupeKey: string } | null {
  const payload = asRecord(event.payload)
  if (!payload) return null

  if (event.type === "approval.resolved") {
    const resolution = asRecord(payload.resolution)
    const option = asText(resolution?.option) ?? asText(payload.option)
    if (option !== "merge") return null
    const runId = asText(payload.run_id) ?? undefined
    const requestedBy = asText(payload.requested_by)
    const run = runId ? runs.find((item) => item.id === runId) : undefined
    const member =
      resolveMemberByRef(members, requestedBy) ??
      (run ? resolveMemberByRef(members, run.agent_id) : null)
    if (!member) return null
    const key = runId ? `merge:run:${runId}` : `merge:approval:${asText(payload.id) ?? event.id}`
    return { memberId: member.id, runId, dedupeKey: key }
  }

  if (event.type === "run.merged") {
    const runId = asText(payload.run_id) ?? asText(payload.id) ?? undefined
    const agentRef = asText(payload.agent_id) ?? asText(payload.member_id)
    const run = runId ? runs.find((item) => item.id === runId) : undefined
    const member =
      resolveMemberByRef(members, agentRef) ??
      (run ? resolveMemberByRef(members, run.agent_id) : null)
    if (!member) return null
    const key = runId ? `merge:run:${runId}` : `merge:event:${event.id}`
    return { memberId: member.id, runId, dedupeKey: key }
  }

  if (event.type === "run.updated") {
    const state = asText(payload.state)
    const mode = asText(payload.mode)
    if (state !== "done" || mode !== "write") return null
    const runId = asText(payload.id) ?? undefined
    const agentRef = asText(payload.agent_id)
    const member = resolveMemberByRef(members, agentRef)
    if (!member) return null
    const key = runId ? `merge:run:${runId}` : `merge:event:${event.id}`
    return { memberId: member.id, runId, dedupeKey: key }
  }

  return null
}

export function pruneAnimationQueue(queue: OfficeAnimationQueue, now: number): OfficeAnimationQueue {
  const active = queue.items.filter((item) => now < item.endsAt)
  if (active.length === queue.items.length) return queue
  return {
    items: active,
    seenKeys: queue.seenKeys.slice(-64),
  }
}

export function enqueueOfficeEvent(
  queue: OfficeAnimationQueue,
  event: StreamEvent,
  context: EnqueueContext,
): OfficeAnimationQueue {
  const pruned = pruneAnimationQueue(queue, context.now)
  const runs = context.runs ?? []

  const handoff = parseHandoffPayload(event)
  if (handoff) {
    const sender = resolveMemberByRef(context.members, handoff.from)
    const target = resolveMemberByRef(context.members, handoff.to)
    if (!sender || !target || sender.id === target.id) return pruned

    const dedupeKey = `handoff:${handoff.requestId}:${sender.id}:${target.id}:${handoff.depth}`
    if (pruned.seenKeys.includes(dedupeKey)) return pruned

    const anim: HandoffAnimation = {
      id: `anim-${event.id || handoff.messageId}`,
      kind: "handoff",
      dedupeKey,
      fromMemberId: sender.id,
      toMemberId: target.id,
      fromHandle: sender.handle,
      toHandle: target.handle,
      startedAt: context.now,
      endsAt: context.now + HANDOFF_DURATION_MS,
      durationMs: HANDOFF_DURATION_MS,
    }
    return {
      items: [...pruned.items, anim],
      seenKeys: [...pruned.seenKeys.slice(-63), dedupeKey],
    }
  }

  const merge = parseMergePayload(event, context.members, runs)
  if (merge) {
    if (pruned.seenKeys.includes(merge.dedupeKey)) return pruned
    const anim: MergeAnimation = {
      id: `anim-${event.id || merge.dedupeKey}`,
      kind: "merge",
      dedupeKey: merge.dedupeKey,
      memberId: merge.memberId,
      runId: merge.runId,
      startedAt: context.now,
      endsAt: context.now + MERGE_POP_DURATION_MS,
      durationMs: MERGE_POP_DURATION_MS,
    }
    return {
      items: [...pruned.items, anim],
      seenKeys: [...pruned.seenKeys.slice(-63), merge.dedupeKey],
    }
  }

  return pruned
}

export type HandoffPhase = "stand" | "walk_out" | "deliver" | "walk_back" | "sit"

export interface HandoffWalkSample {
  progress: number
  phase: HandoffPhase
  position: [number, number, number]
  yaw: number
  hasPaper: boolean
  strideAngle: number
  bobY: number
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

export function sampleHandoffWalk(
  anim: HandoffAnimation,
  fromPos: [number, number, number],
  toPos: [number, number, number],
  now: number,
  reducedMotion = false,
): HandoffWalkSample {
  const rawProgress = anim.durationMs > 0 ? (now - anim.startedAt) / anim.durationMs : 1
  const progress = clamp01(rawProgress)

  const dx = toPos[0] - fromPos[0]
  const dz = toPos[2] - fromPos[2]
  const outYaw = Math.atan2(dx, dz)
  const backYaw = Math.atan2(-dx, -dz)

  if (reducedMotion) {
    const midX = lerp(fromPos[0], toPos[0], 0.5)
    const midZ = lerp(fromPos[2], toPos[2], 0.5)
    return {
      progress,
      phase: progress < 0.5 ? "deliver" : "sit",
      position: progress < 0.5 ? [midX, fromPos[1], midZ] : [...fromPos],
      yaw: progress < 0.5 ? outYaw : backYaw,
      hasPaper: progress <= 0.52,
      strideAngle: 0,
      bobY: 0,
    }
  }

  let phase: HandoffPhase = "stand"
  let travelT = 0
  let yaw = outYaw

  if (progress < 0.1) {
    phase = "stand"
    travelT = 0
    yaw = outYaw
  } else if (progress < 0.46) {
    phase = "walk_out"
    travelT = clamp01((progress - 0.1) / 0.36)
    yaw = outYaw
  } else if (progress < 0.56) {
    phase = "deliver"
    travelT = 1
    yaw = outYaw
  } else if (progress < 0.92) {
    phase = "walk_back"
    travelT = 1 - clamp01((progress - 0.56) / 0.36)
    yaw = backYaw
  } else {
    phase = "sit"
    travelT = 0
    yaw = 0
  }

  const x = lerp(fromPos[0], toPos[0], travelT)
  const z = lerp(fromPos[2], toPos[2], travelT)
  const walking = phase === "walk_out" || phase === "walk_back"
  const stepCycle = progress * Math.PI * 14
  const strideAngle = walking ? Math.sin(stepCycle) * 0.42 : 0
  const bobY = walking ? Math.abs(Math.sin(stepCycle)) * 0.045 : 0

  return {
    progress,
    phase,
    position: [x, fromPos[1] + bobY, z],
    yaw,
    hasPaper: progress <= 0.52,
    strideAngle,
    bobY,
  }
}

export interface MergePopSample {
  progress: number
  scale: number
  offsetY: number
  opacity: number
}

export function sampleMergePop(anim: MergeAnimation, now: number, reducedMotion = false): MergePopSample {
  const progress = clamp01(anim.durationMs > 0 ? (now - anim.startedAt) / anim.durationMs : 1)
  if (reducedMotion) {
    return {
      progress,
      scale: 1,
      offsetY: 0.35,
      opacity: 1,
    }
  }
  const popScale = progress < 0.2 ? lerp(0.4, 1.18, progress / 0.2) : progress < 0.35 ? lerp(1.18, 1, (progress - 0.2) / 0.15) : 1
  const offsetY = 0.25 + progress * 0.22
  const opacity = progress > 0.78 ? clamp01(1 - (progress - 0.78) / 0.22) : 1
  return {
    progress,
    scale: popScale,
    offsetY,
    opacity,
  }
}

import { mentionHandles } from "../../../lib/mentions"
import type { Member, StreamEvent } from "../../../types"
import { resolveMemberByRef } from "./animations"

export const MENTION_PULSE_MS = 60_000

export interface MentionRecord {
  memberId: string
  at: number
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

export function mentionRecordsFromEvent(event: StreamEvent, members: readonly Member[], at: number): MentionRecord[] {
  if (event.type !== "message.posted" && event.type !== "message.updated") return []
  const payload = asRecord(event.payload)
  if (!payload) return []
  const ids = new Set<string>()
  if (Array.isArray(payload.mentions)) {
    for (const raw of payload.mentions) {
      if (typeof raw !== "string") continue
      const member = resolveMemberByRef(members, raw)
      if (member) ids.add(member.id)
    }
  }
  if (typeof payload.body === "string") {
    for (const handle of mentionHandles(payload.body)) {
      const member = resolveMemberByRef(members, handle)
      if (member) ids.add(member.id)
    }
  }
  return [...ids].map((memberId) => ({ memberId, at }))
}

export function mentionRecordsFromEvents(events: readonly StreamEvent[], members: readonly Member[]): MentionRecord[] {
  const records: MentionRecord[] = []
  for (const event of events) {
    const at = Date.parse(event.ts)
    if (Number.isNaN(at)) continue
    records.push(...mentionRecordsFromEvent(event, members, at))
  }
  return records
}

export function activeMentionIds(
  records: readonly MentionRecord[],
  now: number,
  windowMs = MENTION_PULSE_MS,
): string[] {
  const ids: string[] = []
  const seen = new Set<string>()
  for (const record of records) {
    if (seen.has(record.memberId)) continue
    if (now < record.at) continue
    if (now - record.at >= windowMs) continue
    seen.add(record.memberId)
    ids.push(record.memberId)
  }
  return ids
}

export function approvalCardOffsetY(elapsedSec: number, reducedMotion: boolean, seed = 0): number {
  if (reducedMotion) return 0
  return Math.sin(elapsedSec * 2.15 + (seed % 17) * 0.2) * 0.045
}

export function nextCodeScroll(offset: number, deltaSec: number, reducedMotion: boolean): number {
  if (reducedMotion || deltaSec <= 0) return offset
  const next = offset - deltaSec * 0.08
  return next - Math.floor(next)
}

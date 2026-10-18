import type { Channel, Member, StreamEvent } from "../types"
import { plainPreview } from "./inbox"
import { isDirect } from "./direct"

// Events older than this are replays from a reconnect, not news.
const FRESH_MS = 60_000

export interface NotifyContext {
  meId: string
  members: Member[]
  channels: Channel[]
  muted: ReadonlySet<string>
  now: number
}

export interface NotifyItem {
  title: string
  body: string
  channelId: string
  /** Set for an approval, so a click opens it in the approvals inbox. */
  approvalId?: string
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function clip(value: string, max = 140): string {
  const plain = plainPreview(value)
  return plain.length > max ? `${plain.slice(0, max - 1)}...` : plain
}

// Decides whether an event deserves a desktop notification: a message that
// mentions me (or any message in a direct chat), an approval waiting for me,
// or a run that failed. Muted channels never notify.
export function notificationFor(event: StreamEvent, ctx: NotifyContext): NotifyItem | null {
  const at = Date.parse(event.ts)
  if (!Number.isFinite(at) || ctx.now - at > FRESH_MS) return null
  const payload = record(event.payload)
  const channelId = text(payload.channel_id) || event.channel_id || ""
  if (!channelId || ctx.muted.has(channelId)) return null
  const channel = ctx.channels.find((item) => item.id === channelId)
  const nameOf = (id: string) => ctx.members.find((member) => member.id === id)?.display_name ?? "Someone"

  switch (event.type) {
    case "message.posted": {
      const author = text(payload.author_id)
      if (!author || author === ctx.meId) return null
      const mentions = Array.isArray(payload.mentions) ? payload.mentions : []
      const mentioned = mentions.includes(ctx.meId)
      const dm = channel ? isDirect(channel) : false
      if (!mentioned && !dm) return null
      const where = dm || !channel ? "" : ` in #${channel.name}`
      const body = clip(text(payload.body)) || "Sent a file"
      return { title: mentioned ? `${nameOf(author)} mentioned you${where}` : nameOf(author), body, channelId }
    }
    case "approval.requested": {
      if (payload.state !== "pending") return null
      const approvalId = text(payload.id)
      return {
        title: "Approval waiting",
        body: clip(text(payload.title)) || "An agent needs your decision",
        channelId,
        ...(approvalId ? { approvalId } : {}),
      }
    }
    case "run.updated": {
      if (payload.state !== "failed") return null
      const reason = clip(text(payload.failure_reason))
      return { title: `${nameOf(text(payload.agent_id))} could not finish a run`, body: reason || "The run failed", channelId }
    }
    default:
      return null
  }
}

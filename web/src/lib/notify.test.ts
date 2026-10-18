import { describe, expect, it } from "vitest"
import type { Channel, Member, StreamEvent } from "../types"
import { notificationFor, type NotifyContext } from "./notify"

const NOW = Date.parse("2026-10-18T10:00:00Z")
const me: Member = { id: "me", kind: "human", handle: "user", display_name: "User", presence: "online" }
const coder: Member = { id: "coder", kind: "agent", handle: "coder", display_name: "Coder", presence: "idle" }
const general: Channel = { id: "c1", name: "general", kind: "team", visibility: "public", member_ids: ["me", "coder"], unread: 0 }
const dm: Channel = { id: "c2", name: "dm-coder", kind: "direct", visibility: "direct", member_ids: ["me", "coder"], unread: 0 }

function ctx(over: Partial<NotifyContext> = {}): NotifyContext {
  return { meId: "me", members: [me, coder], channels: [general, dm], muted: new Set(), now: NOW, ...over }
}

function event(type: string, payload: unknown, over: Partial<StreamEvent> = {}): StreamEvent {
  return { seq: 1, id: "e1", version: 1, type, actor: "agent:coder", ts: new Date(NOW - 1000).toISOString(), payload, ...over }
}

const posted = (over: Record<string, unknown> = {}, channel = "c1") =>
  event("message.posted", { id: "m1", channel_id: channel, author_id: "coder", body: "**Done**, see the PR", mentions: [], created_at: "x", ...over })

describe("notificationFor", () => {
  it("notifies when a message mentions me", () => {
    const item = notificationFor(posted({ mentions: ["me"] }), ctx())
    expect(item).toEqual({ title: "Coder mentioned you in #general", body: "Done, see the PR", channelId: "c1" })
  })

  it("ignores messages that do not mention me, and my own", () => {
    expect(notificationFor(posted(), ctx())).toBeNull()
    expect(notificationFor(posted({ author_id: "me", mentions: ["me"] }), ctx())).toBeNull()
  })

  it("notifies for any message from someone else in a direct chat", () => {
    expect(notificationFor(posted({}, "c2"), ctx())).toEqual({ title: "Coder", body: "Done, see the PR", channelId: "c2" })
  })

  it("notifies for a pending approval but not a resolved one", () => {
    const pending = event("approval.requested", { id: "a1", channel_id: "c1", title: "Merge the change?", state: "pending", options: [] })
    // The approval id lets a click open the inbox at that item.
    expect(notificationFor(pending, ctx())).toEqual({ title: "Approval waiting", body: "Merge the change?", channelId: "c1", approvalId: "a1" })
    const resolved = event("approval.resolved", { id: "a1", channel_id: "c1", title: "Merge the change?", state: "resolved", options: [] })
    expect(notificationFor(resolved, ctx())).toBeNull()
  })

  it("notifies for a failed run and no other run state", () => {
    const failed = event("run.updated", { id: "r1", channel_id: "c1", agent_id: "coder", state: "failed", failure_reason: "tests failed" })
    expect(notificationFor(failed, ctx())).toEqual({ title: "Coder could not finish a run", body: "tests failed", channelId: "c1" })
    expect(notificationFor(event("run.updated", { id: "r1", channel_id: "c1", state: "done" }), ctx())).toBeNull()
    expect(notificationFor(event("run.updated", { id: "r1", channel_id: "c1", state: "running" }), ctx())).toBeNull()
  })

  it("stays quiet for a muted channel", () => {
    const muted = ctx({ muted: new Set(["c1"]) })
    expect(notificationFor(posted({ mentions: ["me"] }), muted)).toBeNull()
    expect(notificationFor(posted({ mentions: ["me"] }, "c2"), muted)).not.toBeNull()
  })

  it("ignores events replayed from a reconnect", () => {
    const old = posted({ mentions: ["me"] })
    old.ts = new Date(NOW - 10 * 60_000).toISOString()
    expect(notificationFor(old, ctx())).toBeNull()
  })

  it("ignores unrelated events and malformed payloads", () => {
    expect(notificationFor(event("presence.changed", { member_id: "coder" }), ctx())).toBeNull()
    expect(notificationFor(event("message.posted", null), ctx())).toBeNull()
    expect(notificationFor(event("message.posted", "nope"), ctx())).toBeNull()
  })

  it("says a file arrived when the message has no text", () => {
    expect(notificationFor(posted({ body: "", mentions: ["me"] }), ctx())?.body).toBe("Sent a file")
  })
})

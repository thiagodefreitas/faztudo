import { describe, expect, it } from "vitest"
import { offscreenUnread, plainPreview, relativeTime, sortInbox, type InboxItem } from "./inbox"
import type { Channel, Message } from "../types"

describe("plainPreview", () => {
  it.each([
    ["## Docs\n\nSee **bold** and `code`", "Docs See bold and code"],
    ["- one\n- two", "one two"],
    ["[site](https://example.org) now", "site now"],
    ["before\n```go\nx := 1\n```\nafter", "before code after"],
    ["> quoted   text", "quoted text"],
  ])("%j", (input, want) => {
    expect(plainPreview(input)).toBe(want)
  })
})

describe("relativeTime", () => {
  const now = Date.parse("2026-10-18T12:00:00Z")
  it.each([
    ["2026-10-18T11:59:50Z", "now"],
    ["2026-10-18T11:55:00Z", "5m"],
    ["2026-10-18T09:00:00Z", "3h"],
    ["2026-10-16T12:00:00Z", "2d"],
    [undefined, ""],
    ["garbage", ""],
  ])("%s", (input, want) => {
    expect(relativeTime(input, now)).toBe(want)
  })
})

describe("offscreenUnread", () => {
  const item = (id: string, unread: number): InboxItem => ({
    channel: { id, name: id, kind: "team", visibility: "public", member_ids: [], unread },
    last: undefined,
  })
  it("lists unread conversations that are not visible, in order", () => {
    const items = [item("a", 1), item("b", 0), item("c", 2), item("d", 5)]
    expect(offscreenUnread(items, new Set(["c"]))).toEqual(["a", "d"])
    expect(offscreenUnread(items, new Set(["a", "c", "d"]))).toEqual([])
  })
})

describe("sortInbox", () => {
  const channel = (name: string): Channel => ({
    id: name,
    name,
    kind: "team",
    visibility: "public",
    member_ids: [],
    unread: 0,
  })
  const message = (at: string): Message => ({
    id: at,
    channel_id: "x",
    author_id: "a",
    body: "hi",
    mentions: [],
    created_at: at,
  })
  it("orders by last activity and puts empty conversations last", () => {
    const sorted = sortInbox([
      { channel: channel("empty"), last: undefined },
      { channel: channel("old"), last: message("2026-10-18T08:00:00Z") },
      { channel: channel("new"), last: message("2026-10-18T09:00:00Z") },
    ])
    expect(sorted.map((item) => item.channel.name)).toEqual(["new", "old", "empty"])
  })
})

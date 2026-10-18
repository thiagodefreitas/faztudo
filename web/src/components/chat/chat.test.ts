import { describe, expect, it } from "vitest"
import type { Approval, Member, Message, Run } from "../../types"
import { buildCatchUp, catchUpSentences } from "./catch-up"
import { dayLabel } from "./day"
import { filterContext, matchesFilter } from "./filters"
import { buildRows, groupsWith, unreadIds } from "./rows"
import { listThreads } from "./threads"

const ada: Member = { id: "ada", kind: "human", handle: "ada", display_name: "Ada", presence: "online" }
const coder: Member = { id: "coder", kind: "agent", handle: "coder", display_name: "Coder", presence: "online", agent: { lanes: [] } }
const reviewer: Member = { id: "rev", kind: "agent", handle: "reviewer", display_name: "Reviewer", presence: "online", agent: { lanes: [] } }
const members = [ada, coder, reviewer]
const NOW = Date.parse("2026-10-18T12:00:00")

function msg(id: string, author: Member, at: string, extra: Partial<Message> = {}): Message {
  return { id, channel_id: "c1", author_id: author.id, body: id, mentions: [], created_at: at, ...extra }
}

function rowsOf(messages: Message[], extra: { unread?: string[]; filter?: "all" | "mentions" | "runs" | "decisions" | "files"; catchUp?: boolean } = {}) {
  return buildRows({
    messages,
    members,
    notices: [],
    pending: [],
    filter: extra.filter ?? "all",
    context: filterContext(ada.id, []),
    unread: new Set(extra.unread ?? []),
    catchUp: extra.catchUp ?? false,
    now: NOW,
  })
}

describe("dayLabel", () => {
  it("names today, yesterday, a weekday and a date", () => {
    expect(dayLabel("2026-10-18T08:00:00", NOW)).toBe("Today")
    expect(dayLabel("2026-10-17T23:00:00", NOW)).toBe("Yesterday")
    expect(dayLabel("2026-10-14T10:00:00", NOW)).toBe("Wednesday")
    expect(dayLabel("2026-09-02T10:00:00", NOW)).toBe("2 Sep")
    expect(dayLabel("2025-09-02T10:00:00", NOW)).toBe("2 Sep 2025")
  })
})

describe("grouping", () => {
  it("groups one author within five minutes and splits after", () => {
    const a = msg("a", ada, "2026-10-18T10:00:00")
    expect(groupsWith(a, msg("b", ada, "2026-10-18T10:04:00"))).toBe(true)
    expect(groupsWith(a, msg("c", ada, "2026-10-18T10:06:00"))).toBe(false)
    expect(groupsWith(a, msg("d", coder, "2026-10-18T10:01:00"))).toBe(false)
  })

  it("never groups a run card, before or after", () => {
    const a = msg("a", coder, "2026-10-18T10:00:00")
    const run = msg("b", coder, "2026-10-18T10:01:00", { run_id: "r1" })
    expect(groupsWith(a, run)).toBe(false)
    expect(groupsWith(run, msg("c", coder, "2026-10-18T10:02:00"))).toBe(false)
  })

  it("marks grouped and last-in-group on rows, and a day change starts a group", () => {
    const rows = rowsOf([
      msg("a", ada, "2026-10-17T23:58:00"),
      msg("b", ada, "2026-10-18T00:01:00"),
      msg("c", ada, "2026-10-18T00:02:00"),
    ])
    const flags = rows.flatMap((row) => (row.kind === "message" ? [[row.message.id, row.grouped, row.lastInGroup]] : []))
    expect(flags).toEqual([
      ["a", false, true],
      ["b", false, false],
      ["c", true, true],
    ])
  })
})

describe("day and new dividers", () => {
  it("adds a day divider per day", () => {
    const rows = rowsOf([msg("a", ada, "2026-10-17T10:00:00"), msg("b", ada, "2026-10-18T10:00:00")])
    expect(rows.filter((r) => r.kind === "day").map((r) => (r.kind === "day" ? r.label : ""))).toEqual(["Yesterday", "Today"])
  })

  it("puts New and the catch-up card right before the first unread message", () => {
    const rows = rowsOf(
      [msg("a", ada, "2026-10-18T09:00:00"), msg("b", coder, "2026-10-18T10:00:00"), msg("c", coder, "2026-10-18T10:01:00")],
      { unread: ["b", "c"], catchUp: true },
    )
    expect(rows.map((r) => r.kind)).toEqual(["day", "message", "new", "catchup", "message", "message"])
    expect(rows[4]?.key).toBe("b")
  })

  it("has no divider without unread messages", () => {
    expect(rowsOf([msg("a", ada, "2026-10-18T09:00:00")]).some((r) => r.kind === "new")).toBe(false)
  })

  it("picks the unread messages that others wrote, newest first", () => {
    const all = [msg("a", coder, "2026-10-18T09:00:00"), msg("b", ada, "2026-10-18T09:01:00"), msg("c", coder, "2026-10-18T09:02:00")]
    expect([...unreadIds(all, 1, ada.id)]).toEqual(["c"])
    expect([...unreadIds(all, 5, ada.id)]).toEqual(["a", "c"])
    expect(unreadIds(all, 0, ada.id).size).toBe(0)
  })
})

describe("filters", () => {
  const approval = { id: "ap", run_id: "r2", channel_id: "c1", state: "pending" } as Approval
  const context = filterContext(ada.id, [approval])
  const mention = msg("m", coder, "2026-10-18T10:00:00", { mentions: [ada.id] })
  const own = msg("o", ada, "2026-10-18T10:00:00", { mentions: [ada.id] })
  const run = msg("r", coder, "2026-10-18T10:00:00", { run_id: "r1" })
  const decided = msg("d", coder, "2026-10-18T10:00:00", { run_id: "r2" })
  const choice = msg("ch", coder, "2026-10-18T10:00:00", { options: ["yes", "no"] })
  const file = msg("f", ada, "2026-10-18T10:00:00", { attachments: [{ id: "x", name: "a.txt", content_type: "text/plain", size: 1 }] })
  const plain = msg("p", ada, "2026-10-18T10:00:00")

  it("matches each chip", () => {
    const pick = (filter: "mentions" | "runs" | "decisions" | "files") =>
      [mention, own, run, decided, choice, file, plain].filter((m) => matchesFilter(m, filter, context)).map((m) => m.id)
    expect(pick("mentions")).toEqual(["m"])
    expect(pick("runs")).toEqual(["r", "d"])
    expect(pick("decisions")).toEqual(["d", "ch"])
    expect(pick("files")).toEqual(["f"])
    expect(matchesFilter(plain, "all", context)).toBe(true)
  })

  it("filters rows and drops the day divider of an empty day", () => {
    const rows = rowsOf([plain, run], { filter: "runs" })
    expect(rows.map((r) => r.key)).toEqual(["day:2026-10-18", "r"])
  })
})

describe("catch-up", () => {
  const m1 = msg("m1", coder, "2026-10-18T10:00:00")
  const m2 = msg("m2", reviewer, "2026-10-18T10:05:00", { run_id: "r2" })
  const m3 = msg("m3", coder, "2026-10-18T10:06:00", { run_id: "r1" })
  const base = { id: "", channel_id: "c1", trigger_message_id: "m1", lane_id: "l", mode: "write", state: "done" } as const
  const runs: Run[] = [
    { ...base, id: "r1", agent_id: coder.id, ended_at: "2026-10-18T10:20:00" },
    { ...base, id: "r2", agent_id: reviewer.id, state: "failed", ended_at: "2026-10-18T10:21:00" },
    { ...base, id: "old", agent_id: coder.id, ended_at: "2026-10-18T08:00:00" },
  ]
  const approvals = [
    { id: "a1", run_id: "r1", channel_id: "c1", title: "Merge Coder's change", state: "resolved", resolution: { option: "merge", by: ada.id, at: "x" } },
    { id: "a2", run_id: "r3", channel_id: "c1", title: "Push branch", state: "pending" },
  ] as Approval[]

  it("says who wrote, what merged, failed and waits, with links", () => {
    const data = buildCatchUp({
      channelId: "c1",
      unread: [m1, m2, m3],
      all: [m1, m2, m3],
      members,
      runs,
      approvals,
      summary: "Coder fixed login. Reviewer is next.",
    })
    expect(catchUpSentences(data)).toEqual([
      "3 new messages from Coder and Reviewer.",
      "1 run merged.",
      "1 run failed.",
      "1 waiting on you.",
    ])
    expect(data.merged[0]).toEqual({ text: "Coder merged a change", messageId: "m3" })
    expect(data.failed[0]).toEqual({ text: "Reviewer failed", messageId: "m2" })
    expect(data.waiting[0]).toEqual({ text: "Push branch" })
    expect(data.summary).toBe("Coder fixed login.")
  })
})

describe("threads", () => {
  it("lists threads with replies, newest activity first, and flags unread replies", () => {
    const r1 = msg("r1", ada, "2026-10-18T09:00:00", { reply_count: 2 })
    const r2 = msg("r2", ada, "2026-10-18T09:30:00", { reply_count: 1 })
    const quiet = msg("q", ada, "2026-10-18T09:40:00")
    const a = msg("a", coder, "2026-10-18T10:00:00", { thread_id: "r1" })
    const b = msg("b", reviewer, "2026-10-18T10:05:00", { thread_id: "r1" })
    const c = msg("c", coder, "2026-10-18T09:35:00", { thread_id: "r2" })
    const list = listThreads([r1, r2, quiet, a, b, c], new Set(["c"]))
    expect(list.map((t) => [t.root.id, t.replies, t.participants, t.unread])).toEqual([
      ["r1", 2, ["ada", "coder", "rev"], false],
      ["r2", 1, ["ada", "coder"], true],
    ])
    expect(list[0]?.lastReplyAt).toBe("2026-10-18T10:05:00")
  })
})

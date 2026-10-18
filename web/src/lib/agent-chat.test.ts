import { describe, expect, it } from "vitest"
import { collapseAgentChat, participants } from "./agent-chat"
import type { Member, Message } from "../types"

const member = (id: string, kind: Member["kind"]): Member => ({
  id,
  kind,
  handle: id,
  display_name: id,
  presence: "online",
})
const members = [member("ada", "human"), member("coder", "agent"), member("reviewer", "agent")]

let n = 0
const msg = (author: string, mentions: string[], extra: Partial<Message> = {}): Message => ({
  id: `m${++n}`,
  channel_id: "c",
  author_id: author,
  body: "hi",
  mentions,
  created_at: "2026-10-18T10:00:00Z",
  ...extra,
})

describe("collapseAgentChat", () => {
  it("joins consecutive agent-to-agent messages", () => {
    const out = collapseAgentChat(
      [msg("ada", ["coder"]), msg("coder", ["reviewer"]), msg("reviewer", ["coder"]), msg("ada", [])],
      members,
    )
    expect(out.map((s) => s.kind)).toEqual(["message", "agents", "message"])
    expect(out[1]?.kind === "agents" && out[1].messages.length).toBe(2)
  })

  it.each([
    ["mentions a human", msg("coder", ["ada"])],
    ["mentions a human and an agent", msg("coder", ["reviewer", "ada"])],
    ["mentions nobody", msg("coder", [])],
    ["mentions itself", msg("coder", ["coder"])],
    ["offers choices", msg("coder", ["reviewer"], { options: ["a", "b"] })],
    ["is written by a human", msg("ada", ["reviewer"])],
  ])("never collapses a message that %s", (_name, message) => {
    expect(collapseAgentChat([message], members)).toEqual([{ kind: "message", message }])
  })

  it("keeps a human message between two agent runs apart", () => {
    const out = collapseAgentChat(
      [msg("coder", ["reviewer"]), msg("ada", []), msg("coder", ["reviewer"])],
      members,
    )
    expect(out.map((s) => s.kind)).toEqual(["agents", "message", "agents"])
  })
})

describe("participants", () => {
  it("lists authors and addressees once, in order", () => {
    const list = participants([msg("coder", ["reviewer"]), msg("reviewer", ["coder"])], members)
    expect(list.map((item) => item.id)).toEqual(["coder", "reviewer"])
  })
})

import { describe, expect, it } from "vitest"
import type { Member } from "../types"
import { applyMention, filterMembers, mentionHandles, mentionQuery } from "./mentions"

const members: Member[] = [
  {
    id: "01ARZ3NDEKTSV4RRFFQ69G5AA2",
    kind: "agent",
    handle: "coder",
    display_name: "Coder",
    presence: "online",
    agent: { lanes: ["codex/default"] },
  },
  {
    id: "01ARZ3NDEKTSV4RRFFQ69G5AA1",
    kind: "human",
    handle: "ada",
    display_name: "Ada",
    presence: "online",
  },
]

describe("mentionQuery", () => {
  it("reads the token at the cursor and ignores emails", () => {
    expect(mentionQuery("hi @co", 6)).toEqual({ start: 3, query: "co" })
    expect(mentionQuery("hi @", 4)).toEqual({ start: 3, query: "" })
    expect(mentionQuery("hi @co", 2)).toBeNull()
    expect(mentionQuery("me@co", 5)).toBeNull()
  })
})

describe("mentionHandles", () => {
  it("collects handles for the server parser", () => {
    expect(mentionHandles("Ask @Coder and @reviewer, not me@ada")).toEqual(["coder", "reviewer"])
  })
})

describe("filterMembers", () => {
  it("prefers a handle prefix and keeps humans in the list", () => {
    expect(filterMembers(members, "c").map((member) => member.handle)).toEqual(["coder"])
    expect(filterMembers(members, "").map((member) => member.handle)).toEqual(["ada", "coder"])
  })
})

describe("applyMention", () => {
  it("replaces the open token with the handle", () => {
    expect(applyMention("hi @co", 6, "coder")).toEqual({ text: "hi @coder ", cursor: 10 })
  })
})

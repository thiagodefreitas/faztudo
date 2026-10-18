import { describe, expect, it } from "vitest"
import { answeredChoice, choiceBody, choiceForKey } from "./choices"
import type { Member, Message } from "../types"

const members: Member[] = [
  { id: "ada", kind: "human", handle: "ada", display_name: "Ada", presence: "online" },
  { id: "coder", kind: "agent", handle: "coder", display_name: "Coder", presence: "online" },
]
const reply = (author: string, body: string): Message => ({
  id: `${author}-${body}`,
  channel_id: "c",
  thread_id: "root",
  author_id: author,
  body,
  mentions: [],
  created_at: "2026-10-18T10:00:00Z",
})

describe("choices", () => {
  const options = ["fast", "safe"]

  it("builds the reply body", () => {
    expect(choiceBody(1, "safe")).toBe("B: safe")
  })

  it("reads the answer from a human reply", () => {
    expect(answeredChoice(options, [reply("ada", "B: safe")], members)).toBe(1)
  })

  it("ignores agent replies and unrelated text", () => {
    expect(answeredChoice(options, [reply("coder", "A: fast"), reply("ada", "maybe")], members)).toBeNull()
  })

  it.each([
    ["a", 3, 0],
    ["C", 3, 2],
    ["d", 3, null],
    ["Enter", 3, null],
    ["1", 3, null],
  ])("key %s of %i", (key, count, want) => {
    expect(choiceForKey(key, count)).toBe(want)
  })
})

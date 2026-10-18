import { describe, expect, it } from "vitest"
import type { Message } from "../types"
import { continuesGroup } from "./group"

function msg(author: string, at: string): Message {
  return { id: `${author}${at}`, channel_id: "c1", author_id: author, body: "x", created_at: at } as Message
}

describe("continuesGroup", () => {
  const a = msg("a", "2026-10-18T10:00:00Z")
  const cases: Array<[string, Message | undefined, Message, boolean]> = [
    ["no previous message", undefined, a, false],
    ["same author inside five minutes", a, msg("a", "2026-10-18T10:04:59Z"), true],
    ["same author at five minutes", a, msg("a", "2026-10-18T10:05:00Z"), false],
    ["other author", a, msg("b", "2026-10-18T10:01:00Z"), false],
    ["bad timestamp", a, msg("a", "nope"), false],
  ]
  for (const [name, prev, next, want] of cases) {
    it(name, () => expect(continuesGroup(prev, next)).toBe(want))
  }
})

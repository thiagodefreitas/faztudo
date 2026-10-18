import { describe, expect, it } from "vitest"
import { noticeWhy } from "./notice-why"

const why = (text: string) => noticeWhy({ text })

describe("noticeWhy", () => {
  it("explains the fallback and the override that blocks it", () => {
    expect(why("Run on kimi/default failed (403). Retrying @coder on codex/default.")).toMatch(/^Fallback rule: when a run fails/)
    expect(why("You chose lane kimi/default for this message, so @coder was not moved to another lane.")).toMatch(/your choice/)
  })

  it("explains lane order, conserve and the queue", () => {
    expect(why("Using codex/default; claude/sonnet was skipped: busy")).toMatch(/^Lane order/)
    expect(why("Using claude/opus although it is in conserve (week at 84): no other lane in @a's chain is usable.")).toMatch(/^Conserve rule/)
    expect(why("@coder is queued: codex/default busy; it starts when a lane frees up.")).toMatch(/^Queue rule/)
  })

  it("explains a project refusal, also from its button", () => {
    expect(why("@coder is not assigned to project Faztudo, so it did not run.")).toMatch(/^Project rule/)
    expect(
      noticeWhy({ text: "Ask the Director.", action: { kind: "assign", label: "Assign", project: "p", agent: "coder" } }),
    ).toMatch(/^Project rule/)
  })

  it("has nothing to say about plain information", () => {
    expect(why("Write runs need a channel repo_path.")).toBeNull()
    expect(why("Welcome")).toBeNull()
  })
})

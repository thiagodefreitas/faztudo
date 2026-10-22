import { describe, expect, it } from "vitest"
import { routinePromptOf, runRequestOf } from "./request"

describe("request", () => {
  it("keeps the lines of a request for a routine", () => {
    expect(routinePromptOf("@coder /lane codex/default\n\nCheck CI.\n\n- list failures")).toBe("Check CI.\n\n- list failures")
    expect(routinePromptOf("just text")).toBe("just text")
    expect(routinePromptOf("@coder")).toBe("@coder")
    expect(routinePromptOf(undefined)).toBe("")
  })

  it("puts a request on one line for cards", () => {
    expect(runRequestOf("@coder /lane codex/default fix it\nnow")).toBe("fix it now")
  })
})

import { describe, expect, it } from "vitest"
import { firstSentence, foldAnswer } from "./answer-fold"

const lines = (count: number, prefix = "line") => Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`).join("\n")

describe("foldAnswer", () => {
  it("leaves a short answer whole", () => {
    expect(foldAnswer(lines(12))).toBeNull()
  })

  it("keeps the first twelve lines of a long answer", () => {
    const folded = foldAnswer(lines(30))
    expect(folded?.head.split("\n")).toHaveLength(12)
    expect(folded?.hidden).toBe(18)
  })

  it("cuts at a blank line so a paragraph is not split", () => {
    const body = `${lines(5)}\n\n${lines(5, "b")}\n\n${lines(10, "c")}`
    const folded = foldAnswer(body)
    expect(folded?.head.endsWith("b 5")).toBe(true)
  })

  it("lists the headings that are hidden", () => {
    const body = `${lines(14)}\n\n## Risks\ntext\n\n### Next steps\ntext`
    expect(foldAnswer(body)?.headings).toEqual(["Risks", "Next steps"])
  })

  it("ignores hash lines inside code and never leaves a fence open", () => {
    const body = ["```sh", ...Array.from({ length: 20 }, (_, i) => `# comment ${i}`), "```", "", "## After"].join("\n")
    const folded = foldAnswer(body)
    expect(folded).not.toBeNull()
    expect(folded!.head.split("\n").filter((l) => l.startsWith("```")).length % 2).toBe(0)
    expect(folded?.headings).toEqual(["After"])
  })
})

describe("firstSentence", () => {
  it("takes the first sentence of the first paragraph", () => {
    expect(firstSentence("Fixed the login check. It also needed a test.\n\nMore.")).toBe("Fixed the login check.")
  })

  it("skips heading marks and shortens a run-on", () => {
    expect(firstSentence("# Title\n\nbody")).toBe("Title")
    expect(firstSentence("word ".repeat(100), 40).length).toBeLessThanOrEqual(40)
    expect(firstSentence("")).toBe("")
  })
})

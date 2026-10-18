import { describe, expect, it } from "vitest"
import { parseDiff, splitFiles } from "./diff"

describe("splitFiles", () => {
  const diff = [
    "diff --git a/a.go b/a.go",
    "index 1..2 100644",
    "--- a/a.go",
    "+++ b/a.go",
    "@@ -1,2 +1,3 @@",
    " keep",
    "-old",
    "--- a comment that is content",
    "+new",
    "+more",
    "diff --git a/dir/b.ts b/dir/b.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/dir/b.ts",
    "@@ -0,0 +1 @@",
    "+x",
    "",
  ].join("\n")

  it("splits per file and counts content lines only", () => {
    const files = splitFiles(diff)
    expect(files.map((f) => [f.path, f.additions, f.deletions])).toEqual([
      ["a.go", 2, 2],
      ["dir/b.ts", 1, 0],
    ])
    expect(files[0]?.lines[0]?.text).toBe("diff --git a/a.go b/a.go")
  })

  it("returns nothing for an empty diff", () => {
    expect(splitFiles("")).toEqual([])
  })
})

describe("parseDiff", () => {
  it("keeps additions, deletions, and headers apart", () => {
    const lines = parseDiff(
      ["diff --git a/n.txt b/n.txt", "--- a/n.txt", "+++ b/n.txt", "@@ -1 +1,2 @@", " keep", "-old", "+new", ""].join(
        "\n",
      ),
    )
    expect(lines.map((line) => line.kind)).toEqual(["meta", "meta", "meta", "hunk", "context", "del", "add"])
  })
})

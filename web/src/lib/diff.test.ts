import { describe, expect, it } from "vitest"
import { parseDiff } from "./diff"

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

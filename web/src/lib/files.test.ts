import { describe, expect, it } from "vitest"
import { formatSize, isInlineImage } from "./files"

describe("files", () => {
  it("shows only the safe image types inline", () => {
    expect(isInlineImage({ content_type: "image/png" })).toBe(true)
    expect(isInlineImage({ content_type: "image/webp" })).toBe(true)
    expect(isInlineImage({ content_type: "image/svg+xml" })).toBe(false)
    expect(isInlineImage({ content_type: "text/html" })).toBe(false)
    expect(isInlineImage({ content_type: "application/octet-stream" })).toBe(false)
  })

  it("formats sizes", () => {
    expect(formatSize(0)).toBe("0 B")
    expect(formatSize(1023)).toBe("1023 B")
    expect(formatSize(1536)).toBe("1.5 KB")
    expect(formatSize(200 * 1024)).toBe("200 KB")
    expect(formatSize(3 * 1024 * 1024)).toBe("3.0 MB")
    expect(formatSize(-1)).toBe("")
  })
})

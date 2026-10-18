import { describe, expect, it } from "vitest"
import { channelIdOf, channelLinks } from "./channel-links"

const channels = [
  { id: "c1", name: "general" },
  { id: "c2", name: "dev-ops" },
]

function run(value: string, type = "paragraph") {
  const tree = { type: "root", children: [{ type, children: [{ type: "text", value }] }] }
  channelLinks(channels)()(tree)
  return tree.children[0]?.children ?? []
}

describe("channelLinks", () => {
  it("links a known channel and keeps the text around it", () => {
    expect(run("see #general now")).toEqual([
      { type: "text", value: "see " },
      { type: "link", url: "/c/c1", children: [{ type: "text", value: "#general" }] },
      { type: "text", value: " now" },
    ])
  })

  it("links at the start and with a trailing dot", () => {
    const out = run("#dev-ops.")
    expect(out[0]).toMatchObject({ type: "link", url: "/c/c2" })
    expect(out[1]).toEqual({ type: "text", value: "." })
  })

  it.each([
    ["an unknown name", "#nothing here"],
    ["a number", "issue #41"],
    ["a word with a hash inside", "a#general"],
    ["a url fragment", "https://example.org/#general"],
  ])("leaves %s alone", (_name, value) => {
    expect(run(value)).toEqual([{ type: "text", value }])
  })

  it("does not touch inline code", () => {
    const tree = { type: "root", children: [{ type: "inlineCode", value: "#general" }] }
    channelLinks(channels)()(tree)
    expect(tree.children).toEqual([{ type: "inlineCode", value: "#general" }])
  })
})

describe("channelIdOf", () => {
  it("reads only channel hrefs", () => {
    expect(channelIdOf("/c/abc")).toBe("abc")
    expect(channelIdOf("/c/abc/x")).toBeNull()
    expect(channelIdOf("https://example.org/c/abc")).toBeNull()
    expect(channelIdOf(undefined)).toBeNull()
  })
})

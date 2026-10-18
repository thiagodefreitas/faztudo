import { describe, expect, it } from "vitest"
import { splitSnippet } from "./snippet"

describe("splitSnippet", () => {
  it("marks the matches and keeps the text around them", () => {
    expect(splitSnippet("ship the \u0001release\u0002 notes")).toEqual([
      { text: "ship the ", hit: false },
      { text: "release", hit: true },
      { text: " notes", hit: false },
    ])
  })

  it("handles several matches, a match at the edges and no match", () => {
    expect(splitSnippet("\u0001a\u0002 b \u0001c\u0002")).toEqual([
      { text: "a", hit: true },
      { text: " b ", hit: false },
      { text: "c", hit: true },
    ])
    expect(splitSnippet("plain")).toEqual([{ text: "plain", hit: false }])
    expect(splitSnippet("")).toEqual([])
  })

  it("never turns markup into anything but text", () => {
    expect(splitSnippet("<b>\u0001x\u0002</b>")).toEqual([
      { text: "<b>", hit: false },
      { text: "x", hit: true },
      { text: "</b>", hit: false },
    ])
  })

  it("survives a marker that was never closed", () => {
    expect(splitSnippet("a \u0001open")).toEqual([
      { text: "a ", hit: false },
      { text: "open", hit: true },
    ])
  })
})

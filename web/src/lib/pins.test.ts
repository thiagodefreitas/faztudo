import { afterEach, describe, expect, it, vi } from "vitest"
import { readPins, togglePin } from "./pins"

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe("pins", () => {
  it("toggles an id on and off", () => {
    expect(togglePin(["a"], "b")).toEqual(["a", "b"])
    expect(togglePin(["a", "b"], "a")).toEqual(["b"])
  })

  it("reads stored ids and ignores junk", () => {
    localStorage.setItem("faztudo.pins", JSON.stringify(["a", 3, "b"]))
    expect(readPins()).toEqual(["a", "b"])
    localStorage.setItem("faztudo.pins", "{not json")
    expect(readPins()).toEqual([])
  })

  it("survives storage that throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied")
    })
    expect(readPins()).toEqual([])
  })
})

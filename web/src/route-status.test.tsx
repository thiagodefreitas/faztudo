import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { isChunkLoadError, RouteError } from "./route-status"

describe("isChunkLoadError", () => {
  it("recognizes browser and bundler chunk failures", () => {
    expect(isChunkLoadError(new TypeError("Failed to fetch dynamically imported module: /assets/page.js"))).toBe(true)
    expect(isChunkLoadError(new Error("Loading chunk 12 failed"))).toBe(true)
    expect(isChunkLoadError(new Error("Importing a module script failed"))).toBe(true)
  })

  it("leaves unrelated errors for the retry state", () => {
    expect(isChunkLoadError(new Error("Request failed"))).toBe(false)
    expect(isChunkLoadError("Loading chunk 12 failed")).toBe(false)
  })
})

describe("RouteError", () => {
  it("offers a reload for a missing chunk after an update", () => {
    render(<RouteError error={new Error("Failed to fetch dynamically imported module: /assets/page.js")} reset={vi.fn()} />)
    expect(screen.getByRole("heading", { name: "This page needs a fresh copy" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument()
  })

  it("offers a retry for an unrelated route error", () => {
    const reset = vi.fn()
    render(<RouteError error={new Error("Request failed")} reset={reset} />)
    fireEvent.click(screen.getByRole("button", { name: "Try again" }))
    expect(reset).toHaveBeenCalledOnce()
  })
})

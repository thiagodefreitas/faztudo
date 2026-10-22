import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router"
import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { ChannelNotFound } from "./channel"

describe("ChannelNotFound", () => {
  it("offers a way home", async () => {
    const root = createRootRoute({ component: ChannelNotFound })
    const router = createRouter({ routeTree: root.addChildren([]), history: createMemoryHistory({ initialEntries: ["/"] }), context: {} })
    await router.load()
    render(<RouterProvider router={router} />)
    expect(screen.getByRole("link", { name: "Go home" })).toHaveAttribute("href", "/")
  })
})

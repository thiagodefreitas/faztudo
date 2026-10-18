import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"
import { BottomTabs, showTabs, tabOf } from "./bottom-tabs"

describe("tab helpers", () => {
  it("maps paths to tabs", () => {
    expect(tabOf("/")).toBe("chats")
    expect(tabOf("/c/abc")).toBe("chats")
    expect(tabOf("/p")).toBe("projects")
    expect(tabOf("/p/faztudo")).toBe("projects")
    expect(tabOf("/office/3d")).toBe("office")
    expect(tabOf("/lanes")).toBeNull()
  })

  it("hides the bar in a channel and on the login pages", () => {
    expect(showTabs("/c/abc")).toBe(false)
    expect(showTabs("/login")).toBe(false)
    expect(showTabs("/pair")).toBe(false)
    expect(showTabs("/")).toBe(true)
    expect(showTabs("/p/x")).toBe(true)
  })
})

async function renderTabs(pathname: string) {
  const rootRoute = createRootRoute({ component: () => <BottomTabs pathname={pathname} /> })
  const router = createRouter({ routeTree: rootRoute.addChildren([]), history: createMemoryHistory({ initialEntries: ["/"] }) })
  await router.load()
  render(<RouterProvider router={router} />)
}

describe("BottomTabs", () => {
  it("offers Chats, Projects, Office and More, and marks the current tab", async () => {
    await renderTabs("/p/faztudo")
    const nav = await screen.findByRole("navigation", { name: "Main" })
    expect(nav).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Projects" })).toHaveAttribute("aria-current", "page")
    expect(screen.getByRole("link", { name: "Office" })).toHaveAttribute("href", "/office")
    expect(screen.getByRole("button", { name: "More" })).toBeInTheDocument()
  })

  it("keeps Lanes, Organization, Routines and Devices under More", async () => {
    const user = userEvent.setup()
    await renderTabs("/")
    await user.click(await screen.findByRole("button", { name: "More" }))
    for (const name of ["Lanes", "Organization", "Routines", "Devices"]) {
      expect(await screen.findByRole("menuitem", { name })).toBeInTheDocument()
    }
  })
})

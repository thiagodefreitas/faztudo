import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"
import { qk } from "../state/keys"
import type { Approval } from "../types"
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

const ask = (id: string, state: Approval["state"]): Approval => ({
  id,
  run_id: `run-${id}`,
  channel_id: "c1",
  requested_by: "m1",
  title: "Merge",
  detail: "",
  options: [],
  state,
})

async function renderTabs(pathname: string, approvals: Approval[] = []) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(qk.approvals, approvals)
  const rootRoute = createRootRoute({ component: () => <BottomTabs pathname={pathname} /> })
  const router = createRouter({ routeTree: rootRoute.addChildren([]), history: createMemoryHistory({ initialEntries: ["/"] }) })
  await router.load()
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
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

  it("shows no badge on More when nothing waits", async () => {
    await renderTabs("/")
    expect(await screen.findByRole("button", { name: "More" })).toBeInTheDocument()
    expect(screen.queryByLabelText(/waiting/)).not.toBeInTheDocument()
  })

  it("badges More and lists Needs you first with its count", async () => {
    const user = userEvent.setup()
    await renderTabs("/", [ask("a", "pending"), ask("b", "pending"), ask("c", "resolved")])
    const more = await screen.findByRole("button", { name: /More/ })
    expect(more).toHaveTextContent("2")
    await user.click(more)
    const items = await screen.findAllByRole("menuitem")
    expect(items[0]).toHaveTextContent("Needs you")
    expect(items[0]).toHaveAttribute("href", "/approvals")
    expect(within(items[0]).getByLabelText("2 waiting")).toBeInTheDocument()
  })

  it("cycles the theme from More without closing the menu", async () => {
    localStorage.clear()
    const user = userEvent.setup()
    await renderTabs("/")
    await user.click(await screen.findByRole("button", { name: "More" }))
    await user.click(await screen.findByRole("menuitem", { name: "Theme: System. Switch to Light." }))
    expect(await screen.findByRole("menuitem", { name: "Theme: Light. Switch to Dark." })).toBeInTheDocument()
    await user.click(screen.getByRole("menuitem", { name: "Theme: Light. Switch to Dark." }))
    await user.click(screen.getByRole("menuitem", { name: "Theme: Dark. Switch to System." }))
    expect(screen.getByRole("menuitem", { name: "Theme: System. Switch to Light." })).toBeInTheDocument()
  })
})

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { api } from "../api/client"
import { qk } from "../state/keys"
import type { Channel, Lane, Member } from "../types"
import { CommandPalette, OPEN_SETTINGS_EVENT } from "./palette"
import { profileOpener } from "./profile/navigation"

const nowCalls = vi.hoisted(() => ({ count: 0 }))
vi.mock("../state/now", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state/now")>()
  return { ...actual, useNow: () => { nowCalls.count += 1; return actual.useNow() } }
})

const ada: Member = { id: "01ARZ3NDEKTSV4RRFFQ69G5AA1", kind: "human", handle: "ada", display_name: "Ada", presence: "online" }
const coder: Member = { id: "01ARZ3NDEKTSV4RRFFQ69G5AA2", kind: "agent", handle: "coder", display_name: "Coder", presence: "online" }
const dev: Channel = { id: "chan-dev", name: "faztudo-dev", kind: "team", visibility: "public", member_ids: [ada.id], unread: 0 }

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

async function setup(channels: Channel[] = [dev], lanes: Lane[] = []) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(qk.members, [ada, coder])
  client.setQueryData(qk.me, ada)
  client.setQueryData(qk.channels, channels)
  client.setQueryData(qk.lanes, lanes)
  const rootRoute = createRootRoute({ component: CommandPalette })
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: "/c/$channelId" }),
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/lanes",
        validateSearch: (q: Record<string, unknown>) => ({ lane: typeof q.lane === "string" ? q.lane : undefined }),
      }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/c/chan-dev"] }),
  })
  await router.load()
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return router
}

const claude: Lane = {
  id: "claude/sonnet",
  cli: "claude",
  cost_class: "premium",
  capacity: 1,
  running: 0,
  health: "conserve",
  windows: [{ name: "5h", used_pct: 83, source: "cli-log", measured_at: new Date().toISOString() }],
  runs_today: 0,
}

describe("CommandPalette", () => {
  it("lists lanes with their main window and opens the Lanes page at the lane", async () => {
    const user = userEvent.setup()
    const router = await setup([dev], [claude])
    await user.keyboard("{Control>}k{/Control}")
    const option = await screen.findByRole("option", { name: /claude\/sonnet/ })
    expect(option).toHaveTextContent("83%")
    await user.keyboard("claude/sonnet{Enter}")
    await waitFor(() => expect(router.state.location.pathname).toBe("/lanes"))
    expect(router.state.location.search).toEqual({ lane: "claude/sonnet" })
  })

  it("opens with Ctrl+K, filters, and jumps to a channel from the keyboard", async () => {
    const user = userEvent.setup()
    const other: Channel = { ...dev, id: "chan-ops", name: "ops" }
    const router = await setup([dev, other])
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    await user.keyboard("{Control>}k{/Control}")
    expect(await screen.findByRole("dialog")).toBeInTheDocument()
    await user.keyboard("ops{Enter}")
    await waitFor(() => expect(router.state.location.pathname).toBe("/c/chan-ops"))
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("opens the Lanes page", async () => {
    const user = userEvent.setup()
    const router = await setup()
    await user.keyboard("{Meta>}k{/Meta}")
    await user.keyboard("lanes{Enter}")
    await waitFor(() => expect(router.state.location.pathname).toBe("/lanes"))
  })

  it("creates and opens a DM with a member", async () => {
    const user = userEvent.setup()
    const created: Channel = { id: "chan-dm", name: "dm-ada-coder", kind: "direct", visibility: "direct", member_ids: [ada.id, coder.id], unread: 0 }
    const create = vi.spyOn(api, "createChannel").mockResolvedValue(created)
    const router = await setup()
    await user.keyboard("{Control>}k{/Control}")
    await user.keyboard("Message Coder{Enter}")
    await waitFor(() => expect(router.state.location.pathname).toBe("/c/chan-dm"))
    expect(create).toHaveBeenCalledWith({
      name: "dm-ada-coder",
      kind: "direct",
      visibility: "direct",
      member_ids: [ada.id, coder.id],
    })
  })

  it("reuses an existing DM, toggles the theme and opens channel settings", async () => {
    const user = userEvent.setup()
    const dm: Channel = { id: "chan-dm", name: "dm-ada-coder", kind: "direct", visibility: "direct", member_ids: [ada.id, coder.id], unread: 0 }
    const create = vi.spyOn(api, "createChannel")
    const router = await setup([dev, dm])
    await user.keyboard("{Control>}k{/Control}Message Coder{Enter}")
    await waitFor(() => expect(router.state.location.pathname).toBe("/c/chan-dm"))
    expect(create).not.toHaveBeenCalled()

    const before = document.documentElement.classList.contains("dark")
    await user.keyboard("{Control>}k{/Control}toggle theme{Enter}")
    expect(document.documentElement.classList.contains("dark")).toBe(!before)

    const seen = vi.fn()
    window.addEventListener(OPEN_SETTINGS_EVENT, seen)
    await user.keyboard("{Control>}k{/Control}channel settings{Enter}")
    expect(seen).toHaveBeenCalledTimes(1)
    window.removeEventListener(OPEN_SETTINGS_EVENT, seen)
  })

  it("groups results and shows shortcuts on the right", async () => {
    const user = userEvent.setup()
    await setup()
    await user.keyboard("{Control>}k{/Control}")
    const dialog = await screen.findByRole("dialog")
    for (const name of ["Go to", "Channels", "Agents", "Actions"]) expect(within(dialog).getByText(name)).toBeInTheDocument()
    const search = screen.getByRole("option", { name: "Search messages" })
    expect(search).toHaveTextContent("Shift")
    expect(screen.getByRole("option", { name: "Lanes" })).toHaveTextContent("Alt")
    expect(screen.getByRole("option", { name: "New task" })).toBeInTheDocument()
    expect(screen.getByRole("option", { name: "Today" })).toBeInTheDocument()
  })

  it("puts the group with the best match first", async () => {
    const user = userEvent.setup()
    const general: Channel = { ...dev, id: "chan-general", name: "general" }
    const router = await setup([dev, general])
    await user.keyboard("{Control>}k{/Control}gen{Enter}")
    await waitFor(() => expect(router.state.location.pathname).toBe("/c/chan-general"))
  })

  it("lists recent picks first when nothing is typed", async () => {
    localStorage.clear()
    const user = userEvent.setup()
    const other: Channel = { ...dev, id: "chan-ops", name: "ops" }
    await setup([dev, other])
    await user.keyboard("{Control>}k{/Control}ops{Enter}")
    await user.keyboard("{Control>}k{/Control}")
    const options = await screen.findAllByRole("option")
    expect(options[0]).toHaveTextContent("ops")
    expect(screen.getByText("Recent")).toBeInTheDocument()
    await user.keyboard("dev")
    expect(screen.queryByText("Recent")).not.toBeInTheDocument()
    localStorage.clear()
  })

  it("opens the keyboard shortcuts sheet with ?, but not while typing", async () => {
    const user = userEvent.setup()
    await setup()
    await user.keyboard("?")
    const sheet = await screen.findByRole("dialog", { name: "Keyboard shortcuts" })
    expect(within(sheet).getByText("Command palette")).toBeInTheDocument()
    expect(within(sheet).getByText("Search messages")).toBeInTheDocument()
    expect(within(sheet).getByText("Lanes page")).toBeInTheDocument()
    await user.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    await user.keyboard("{Control>}k{/Control}")
    await user.keyboard("?")
    expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).not.toBeInTheDocument()
  })

  it("closes on Escape and offers create channel", async () => {
    const user = userEvent.setup()
    await setup()
    await user.keyboard("{Control>}k{/Control}")
    expect(await screen.findByRole("option", { name: "Create channel" })).toBeInTheDocument()
    await user.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
  })
  it("lists a Profile entry for every agent and opens the profile on the current route", async () => {
    const user = userEvent.setup()
    const router = await setup()
    await user.keyboard("{Control>}k{/Control}")
    const option = await screen.findByRole("option", { name: "Profile: @coder" })
    expect(screen.queryByRole("option", { name: "Profile: @ada" })).not.toBeInTheDocument()
    await user.click(option)
    await waitFor(() => expect(new URLSearchParams(router.state.location.searchStr).get("profile")).toBe("coder"))
    expect(router.state.location.pathname).toBe("/c/chan-dev")
  })

  it("hands focus back to the element focused before the palette opened", async () => {
    const user = userEvent.setup()
    const before = document.createElement("button")
    before.textContent = "before"
    document.body.appendChild(before)
    await setup()
    before.focus()
    await user.keyboard("{Control>}k{/Control}")
    await user.click(await screen.findByRole("option", { name: "Profile: @coder" }))
    expect(profileOpener()).toBe(before)
    before.remove()
  })

  it("does not run the clock while closed", async () => {
    const user = userEvent.setup()
    await setup()
    nowCalls.count = 0
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(nowCalls.count).toBe(0)
    await user.keyboard("{Control>}k{/Control}")
    await screen.findByRole("option", { name: "Create channel" })
    expect(nowCalls.count).toBeGreaterThan(0)
  })
})

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { api } from "../api/client"
import { qk } from "../state/keys"
import type { Channel, Member } from "../types"
import { CommandPalette, OPEN_SETTINGS_EVENT } from "./palette"

const ada: Member = { id: "01ARZ3NDEKTSV4RRFFQ69G5AA1", kind: "human", handle: "ada", display_name: "Ada", presence: "online" }
const coder: Member = { id: "01ARZ3NDEKTSV4RRFFQ69G5AA2", kind: "agent", handle: "coder", display_name: "Coder", presence: "online" }
const dev: Channel = { id: "chan-dev", name: "faztudo-dev", kind: "team", visibility: "public", member_ids: [ada.id], unread: 0 }

afterEach(() => vi.restoreAllMocks())

async function setup(channels: Channel[] = [dev]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(qk.members, [ada, coder])
  client.setQueryData(qk.me, ada)
  client.setQueryData(qk.channels, channels)
  const rootRoute = createRootRoute({ component: CommandPalette })
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: "/c/$channelId" }),
      createRoute({ getParentRoute: () => rootRoute, path: "/lanes" }),
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

describe("CommandPalette", () => {
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

  it("closes on Escape and offers create channel", async () => {
    const user = userEvent.setup()
    await setup()
    await user.keyboard("{Control>}k{/Control}")
    expect(await screen.findByRole("option", { name: "Create channel" })).toBeInTheDocument()
    await user.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
  })
})

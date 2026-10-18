import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { api } from "../api/client"
import { qk } from "../state/keys"
import type { Member, Pin } from "../types"
import { PinsDialog } from "./pins-dialog"

const coder: Member = { id: "m-coder", kind: "agent", handle: "coder", display_name: "Coder", presence: "online" }
const pin: Pin = {
  channel_id: "chan-dev",
  message_id: "msg-1",
  pinned_by: "m-ada",
  pinned_at: "2026-10-18T09:00:00Z",
  message: { id: "msg-1", channel_id: "chan-dev", author_id: coder.id, body: "**Deploy** window is Friday", mentions: [], created_at: "2026-10-18T08:00:00Z" },
}

afterEach(() => vi.restoreAllMocks())

async function setup(pins: Pin[]) {
  vi.spyOn(api, "pins").mockResolvedValue(pins)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(qk.members, [coder])
  const rootRoute = createRootRoute({ component: () => <PinsDialog channelId="chan-dev" open onOpenChange={() => {}} /> })
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/c/$channelId",
        validateSearch: (search: Record<string, unknown>) => search as { m?: string },
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

describe("PinsDialog", () => {
  it("lists pinned messages as plain text and shows one in the channel", async () => {
    const user = userEvent.setup()
    const router = await setup([pin])
    expect(await screen.findByText("Deploy window is Friday")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Show in channel" }))
    await waitFor(() => expect(router.state.location.search).toEqual({ m: "msg-1" }))
  })

  it("unpins a message", async () => {
    const user = userEvent.setup()
    const unpin = vi.spyOn(api, "unpinMessage").mockResolvedValue({ pinned: false })
    await setup([pin])
    await user.click(await screen.findByRole("button", { name: "Unpin" }))
    expect(unpin).toHaveBeenCalledWith("msg-1")
  })

  it("says so when nothing is pinned", async () => {
    await setup([])
    expect(await screen.findByText(/Nothing is pinned here yet/)).toBeInTheDocument()
  })
})

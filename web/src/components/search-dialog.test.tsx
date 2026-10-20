import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { api } from "../api/client"
import { qk } from "../state/keys"
import type { Channel, Member, Message, SearchHit } from "../types"
import { OPEN_SEARCH_EVENT, SearchDialog } from "./search-dialog"

const ada: Member = { id: "m-ada", kind: "human", handle: "ada", display_name: "Ada", presence: "online" }
const coder: Member = { id: "m-coder", kind: "agent", handle: "coder", display_name: "Coder", presence: "online" }
const dev: Channel = { id: "chan-dev", name: "faztudo-dev", kind: "team", visibility: "public", member_ids: [ada.id], unread: 0 }

function message(over: Partial<Message>): Message {
  return { id: "msg-1", channel_id: dev.id, author_id: coder.id, body: "the release notes", mentions: [], created_at: "2026-10-18T09:00:00Z", ...over }
}

afterEach(() => vi.restoreAllMocks())

async function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(qk.members, [ada, coder])
  client.setQueryData(qk.me, ada)
  client.setQueryData(qk.channels, [dev])
  const rootRoute = createRootRoute({ component: SearchDialog })
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/c/$channelId",
        validateSearch: (search: Record<string, unknown>) => search as { m?: string; thread?: string },
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

describe("SearchDialog", () => {
  it("searches after a pause, highlights matches as text and jumps to the message", async () => {
    const user = userEvent.setup()
    const hit: SearchHit = { message: message({}), snippet: "the \u0001release\u0002 <b>notes</b>" }
    const search = vi.spyOn(api, "search").mockResolvedValue([hit])
    const router = await setup()
    window.dispatchEvent(new Event(OPEN_SEARCH_EVENT))
    await user.type(await screen.findByRole("textbox", { name: "Search messages" }), "release", { skipClick: true })
    const result = await screen.findByRole("option", { name: /release/ })
    expect(search).toHaveBeenLastCalledWith({ q: "release" })
    expect(result.querySelector("mark")?.textContent).toBe("release")
    expect(result.querySelector("b")).toBeNull() // markup in a message stays text
    expect(result).toHaveTextContent("#faztudo-dev")
    await user.keyboard("{Enter}")
    await waitFor(() => expect(router.state.location.search).toEqual({ m: "msg-1" }))
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("opens the thread for a hit that is a reply", async () => {
    const user = userEvent.setup()
    vi.spyOn(api, "search").mockResolvedValue([{ message: message({ id: "reply-1", thread_id: "root-1" }), snippet: "\u0001reply\u0002" }])
    const router = await setup()
    window.dispatchEvent(new Event(OPEN_SEARCH_EVENT))
    await user.type(await screen.findByRole("textbox", { name: "Search messages" }), "reply", { skipClick: true })
    await user.click(await screen.findByRole("option", { name: /reply/ }))
    await waitFor(() => expect(router.state.location.search).toEqual({ thread: "root-1" }))
  })

  it("limits the search to the open channel when asked, and says when nothing matches", async () => {
    const user = userEvent.setup()
    const search = vi.spyOn(api, "search").mockResolvedValue([])
    await setup()
    window.dispatchEvent(new Event(OPEN_SEARCH_EVENT))
    await user.click(await screen.findByRole("checkbox", { name: "Only this channel" }))
    await user.type(screen.getByRole("textbox", { name: "Search messages" }), "zebra")
    expect(await screen.findByText("No messages match.")).toBeInTheDocument()
    expect(search).toHaveBeenLastCalledWith({ q: "zebra", channel_id: "chan-dev" })
  })

  it("shows an error when the search fails", async () => {
    const user = userEvent.setup()
    vi.spyOn(api, "search").mockRejectedValue(new Error("boom"))
    await setup()
    window.dispatchEvent(new Event(OPEN_SEARCH_EVENT))
    await user.type(await screen.findByRole("textbox", { name: "Search messages" }), "x", { skipClick: true })
    expect(await screen.findByText("Search failed. Try again.")).toBeInTheDocument()
  })
})

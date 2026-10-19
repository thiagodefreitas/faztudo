import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { api } from "../api/client"
import { qk } from "../state/keys"
import { applyEvent } from "../state/cache"
import type { Member, Message } from "../types"
import { MessageList } from "./message-list"
import { ThreadPanel } from "./thread-panel"

const ada: Member = { id: "01ARZ3NDEKTSV4RRFFQ69G5AA1", kind: "human", handle: "ada", display_name: "Ada", presence: "online" }
const root: Message = {
  id: "01CRZ3NDEKTSV4RRFFQ69G5CC1",
  channel_id: "c1",
  author_id: ada.id,
  body: "root message",
  mentions: [],
  created_at: "2026-10-18T12:00:00.000Z",
  reply_count: 1,
}
const reply: Message = { ...root, id: "01CRZ3NDEKTSV4RRFFQ69G5CC2", thread_id: root.id, body: "first reply", reply_count: undefined }

// jsdom has no layout, so the virtualizer would render no rows.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count, getItemKey }: { count: number; getItemKey: (index: number) => string }) => ({
    getTotalSize: () => count * 88,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, key: getItemKey(index), start: index * 88 })),
    measureElement: () => undefined,
  }),
}))

afterEach(() => vi.restoreAllMocks())

function setup(ui: (client: QueryClient) => React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(qk.members, [ada])
  client.setQueryData(qk.me, ada)
  client.setQueryData(qk.runs, [])
  client.setQueryData(qk.notices, [])
  client.setQueryData(qk.pending("c1"), [])
  const rootRoute = createRootRoute({ component: () => ui(client) })
  const router = createRouter({
    routeTree: rootRoute.addChildren([createRoute({ getParentRoute: () => rootRoute, path: "/c/$channelId" })]),
    history: createMemoryHistory({ initialEntries: ["/c/c1"] }),
  })
  return router.load().then(() => {
    render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    )
    return client
  })
}

describe("ThreadPanel", () => {
  it("shows the root and replies and posts a reply with thread_id", async () => {
    const user = userEvent.setup()
    vi.spyOn(api, "thread").mockResolvedValue({ root, replies: [reply] })
    const post = vi.spyOn(api, "postMessage").mockResolvedValue({ ...reply, id: "01CRZ3NDEKTSV4RRFFQ69G5CC3", body: "second" })
    await setup(() => <ThreadPanel channelId="c1" rootId={root.id} />)
    expect(await screen.findByText("root message")).toBeInTheDocument()
    expect(await screen.findByText("first reply")).toBeInTheDocument()
    await user.type(screen.getByLabelText("Reply"), "second{Enter}")
    await waitFor(() => expect(post).toHaveBeenCalled())
    expect(post).toHaveBeenCalledWith("c1", expect.objectContaining({ body: "second", thread_id: root.id }))
    expect(await screen.findByText("second")).toBeInTheDocument()
  })

  it("keeps a reply that failed to send", async () => {
    const user = userEvent.setup()
    localStorage.clear()
    vi.spyOn(api, "thread").mockResolvedValue({ root, replies: [reply] })
    vi.spyOn(api, "postMessage").mockRejectedValue(new Error("offline"))
    await setup(() => <ThreadPanel channelId="c1" rootId={root.id} />)
    await screen.findByText("first reply")
    await user.type(screen.getByLabelText("Reply"), "lost words{Enter}")
    expect(await screen.findByRole("alert")).toHaveTextContent("offline")
    await waitFor(() => expect(screen.getByLabelText("Reply")).toHaveValue("lost words"))
  })

  it("adds a streamed reply live", async () => {
    vi.spyOn(api, "thread").mockResolvedValue({ root, replies: [] })
    const client = await setup(() => <ThreadPanel channelId="c1" rootId={root.id} />)
    client.setQueryData(qk.messages("c1"), [root])
    await screen.findByText("root message")
    applyEvent(client, {
      seq: 1,
      id: "01EVAAAAAAAAAAAAAAAAAAAAAA",
      version: 1,
      type: "message.posted",
      actor: "system",
      channel_id: "c1",
      ts: "2026-10-18T12:01:00.000Z",
      payload: reply,
    })
    expect(await screen.findByText("first reply")).toBeInTheDocument()
  })
})

describe("MessageList threads", () => {
  it("hides replies, shows the count and opens the thread", async () => {
    const user = userEvent.setup()
    const open = vi.fn()
    await setup((client) => {
      client.setQueryData(qk.messages("c1"), [root, reply])
      return <MessageList channelId="c1" onRetry={() => undefined} onOpenThread={open} />
    })
    expect(screen.getByText("root message")).toBeInTheDocument()
    expect(screen.queryByText("first reply")).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "1 reply" }))
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: root.id }))
    await user.click(screen.getByRole("button", { name: /Reply in thread/ }))
    expect(open).toHaveBeenCalledTimes(2)
  })
})

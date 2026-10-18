import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router"
import { render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { qk } from "../state/keys"
import type { Channel, Member, Message } from "../types"
import { InboxPage } from "./inbox"

const ada: Member = { id: "ada", kind: "human", handle: "ada", display_name: "Ada", presence: "online" }
const bob: Member = { id: "bob", kind: "human", handle: "bob", display_name: "Bob", presence: "idle" }
const coder: Member = {
  id: "coder",
  kind: "agent",
  handle: "coder",
  display_name: "Coder",
  presence: "online",
  agent: { lanes: ["claude/default"] },
}

const general: Channel = {
  id: "c1",
  name: "general",
  kind: "team",
  visibility: "public",
  member_ids: [ada.id, bob.id, coder.id],
  unread: 0,
}
const coderDm: Channel = {
  id: "c2",
  name: "dm-ada-coder",
  kind: "direct",
  visibility: "direct",
  member_ids: [ada.id, coder.id],
  unread: 3,
}

function message(id: string, channel: string, author: Member, at: string, body: string): Message {
  return { id, channel_id: channel, author_id: author.id, body, mentions: [], created_at: at }
}

async function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(qk.me, ada)
  client.setQueryData(qk.members, [ada, bob, coder])
  client.setQueryData(qk.channels, [general, coderDm])
  client.setQueryData(qk.messages("c1"), [message("m1", "c1", bob, new Date(Date.now() - 3 * 3600_000).toISOString(), "Notes for the **week**")])
  client.setQueryData(qk.messages("c2"), [message("m2", "c2", coder, new Date(Date.now() - 60_000).toISOString(), "## Done\n\nThe patch is ready")])
  const rootRoute = createRootRoute({ component: InboxPage })
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: "/c/$channelId" }),
      createRoute({ getParentRoute: () => rootRoute, path: "/settings/devices" }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  })
  await router.load()
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

afterEach(() => localStorage.clear())

describe("InboxPage", () => {
  it("sorts by last activity and shows previews with an author prefix in channels", async () => {
    await setup()
    const list = await screen.findByTestId("inbox-list")
    const rows = within(list).getAllByRole("link")
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent("Coder")
    expect(rows[0]).toHaveTextContent("Done The patch is ready")
    expect(rows[0]).not.toHaveTextContent("##")
    expect(within(rows[0] as HTMLElement).getByLabelText("3 unread")).toBeInTheDocument()
    expect(rows[1]).toHaveTextContent("# general")
    expect(rows[1]).toHaveTextContent("Bob: Notes for the week")
    expect(rows[1]).toHaveTextContent(/\dh/)
  })

  it("shows a team icon for a channel and no pill without hidden unread rows", async () => {
    await setup()
    expect(await screen.findByTestId("team-icon")).toBeInTheDocument()
    expect(screen.queryByText(/ unread$/)).not.toBeInTheDocument()
  })

  it("lists pinned agents with their names", async () => {
    localStorage.setItem("faztudo.pins", JSON.stringify([coder.id]))
    await setup()
    const pinned = await screen.findByRole("region", { name: "Pinned agents" })
    expect(within(pinned).getByRole("button", { name: "Coder" })).toBeInTheDocument()
    expect(within(pinned).getByRole("button", { name: "Pin agents" })).toBeInTheDocument()
  })
})

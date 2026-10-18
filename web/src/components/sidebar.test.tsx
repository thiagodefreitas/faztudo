import * as Tooltip from "@radix-ui/react-tooltip"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router"
import { render, screen, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { qk } from "../state/keys"
import type { Channel, Member } from "../types"
import { WorkspaceNav } from "./sidebar"

const ada: Member = { id: "01ARZ3NDEKTSV4RRFFQ69G5AA1", kind: "human", handle: "ada", display_name: "Ada", presence: "online" }
const bob: Member = { id: "01ARZ3NDEKTSV4RRFFQ69G5AA3", kind: "human", handle: "bob", display_name: "Bob", presence: "idle" }
const coder: Member = {
  id: "01ARZ3NDEKTSV4RRFFQ69G5AA2",
  kind: "agent",
  handle: "coder",
  display_name: "Coder",
  presence: "busy",
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

async function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(qk.me, ada)
  client.setQueryData(qk.members, [ada, bob, coder])
  client.setQueryData(qk.channels, [general, coderDm])
  client.setQueryData(qk.lanes, [])
  const rootRoute = createRootRoute({ component: () => <WorkspaceNav /> })
  const router = createRouter({
    routeTree: rootRoute.addChildren([createRoute({ getParentRoute: () => rootRoute, path: "/c/$channelId" })]),
    history: createMemoryHistory({ initialEntries: ["/c/c1"] }),
  })
  await router.load()
  render(
    <QueryClientProvider client={client}>
      <Tooltip.Provider>
        <RouterProvider router={router} />
      </Tooltip.Provider>
    </QueryClientProvider>,
  )
}

describe("WorkspaceNav", () => {
  it("lists each agent once and shows its unread count", async () => {
    await setup()
    expect(await screen.findAllByText("Coder")).toHaveLength(1)
    const row = screen.getByText("Coder").closest("li")
    expect(row).not.toBeNull()
    expect(within(row as HTMLElement).getByLabelText("3 unread")).toBeInTheDocument()
    expect(screen.queryByText("dm-ada-coder")).not.toBeInTheDocument()
  })

  it("keeps channels, direct messages with people, then agents", async () => {
    await setup()
    const headings = (await screen.findAllByText(/^(Channels|Direct messages|Agents)$/)).map((el) => el.textContent)
    expect(headings).toEqual(["Channels", "Direct messages", "Agents"])
    expect(screen.getByText("Bob")).toBeInTheDocument()
  })

  it("shows the lane summary as a compact Lanes link", async () => {
    await setup()
    const link = await screen.findByRole("link", { name: /^Lane health/ })
    expect(link).toHaveTextContent("Lanes")
    expect(link).not.toHaveTextContent("Unknown 8")
  })
})

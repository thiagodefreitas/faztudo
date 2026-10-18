import * as Tooltip from "@radix-ui/react-tooltip"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router"
import { render, screen, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { qk } from "../state/keys"
import type { Channel, Member, Run } from "../types"
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

const claude: Member = {
  id: "01ARZ3NDEKTSV4RRFFQ69G5AA4",
  kind: "agent",
  handle: "claude",
  display_name: "Claude",
  presence: "online",
  agent: { lanes: ["claude/default"] },
}

const coderRun: Run = {
  id: "r1",
  channel_id: "c1",
  trigger_message_id: "m1",
  agent_id: coder.id,
  lane_id: "claude/default",
  mode: "write",
  state: "running",
  started_at: "2026-10-18T12:00:00.000Z",
}

async function setup(options: { members?: Member[]; runs?: Run[] } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(qk.me, ada)
  client.setQueryData(qk.members, options.members ?? [ada, bob, coder])
  client.setQueryData(qk.runs, options.runs ?? [])
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

  it("marks a raw CLI busy for the persona using its lane", async () => {
    await setup({ members: [ada, claude, coder], runs: [coderRun] })
    const row = (await screen.findByText("Claude")).closest("li") as HTMLElement
    const busy = within(row).getByTitle("Busy for @coder")
    expect(busy).toBeInTheDocument()
    expect(busy).toHaveAttribute("data-busy-for", "coder")
    const coderRow = screen.getByText("Coder").closest("li") as HTMLElement
    expect(within(coderRow).queryByTitle(/^Busy for/)).not.toBeInTheDocument()
  })

  it("shows no busy mark when the lane is free", async () => {
    await setup({ members: [ada, claude, coder], runs: [{ ...coderRun, state: "done" }] })
    const row = (await screen.findByText("Claude")).closest("li") as HTMLElement
    expect(within(row).queryByTitle(/^Busy for/)).not.toBeInTheDocument()
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

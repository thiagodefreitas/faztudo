import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { api } from "../api/client"
import { qk } from "../state/keys"
import type { Channel, Member, Org, Run } from "../types"
import { MembersPanel } from "./members-panel"

const ada: Member = { id: "ada", kind: "human", handle: "ada", display_name: "Ada", presence: "online" }
const bob: Member = { id: "bob", kind: "human", handle: "bob", display_name: "Bob", presence: "online" }
const agent = (handle: string, name: string, role: string): Member => ({
  id: handle,
  kind: "agent",
  handle,
  display_name: name,
  presence: "idle",
  agent: { lanes: ["codex/default"], role },
})
const coder = agent("coder", "Coder", "Implements changes")
const reviewer = agent("reviewer", "Reviewer", "Reviews diffs")
const writer = agent("writer", "Writer", "Writes docs")

const org: Org = {
  director_id: ada.id,
  departments: [{ handle: "engineering", display_name: "Engineering", lead: "coder", members: ["coder"] }],
  projects: [{ handle: "faztudo", name: "Faztudo", channels: ["faztudo-dev"], departments: ["engineering"], specialists: [] }],
}

const dev: Channel = {
  id: "c1",
  name: "faztudo-dev",
  kind: "project",
  visibility: "public",
  member_ids: [ada.id, coder.id, reviewer.id],
  default_agent_id: coder.id,
  unread: 0,
}

const running: Run = {
  id: "r1",
  channel_id: "c1",
  trigger_message_id: "m",
  agent_id: coder.id,
  lane_id: "codex/default",
  mode: "write",
  state: "running",
  started_at: new Date().toISOString(),
}

afterEach(() => {
  vi.restoreAllMocks()
})

async function mount(channel: Channel = dev) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(qk.me, ada)
  client.setQueryData(qk.members, [ada, bob, coder, reviewer, writer])
  client.setQueryData(qk.org, org)
  client.setQueryData(qk.channels, [channel])
  client.setQueryData(qk.runs, [running])
  client.setQueryData(qk.approvals, [])
  client.setQueryData(qk.lanes, [{ id: "codex/default", cli: "codex", cost_class: "standard", capacity: 1, running: 1, health: "available", windows: [], runs_today: 1 }])
  const rootRoute = createRootRoute({ component: () => <MembersPanel channel={channel} open onOpenChange={() => undefined} /> })
  const router = createRouter({
    routeTree: rootRoute.addChildren([createRoute({ getParentRoute: () => rootRoute, path: "/p/$handle" })]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  })
  await router.load()
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return client
}

describe("MembersPanel", () => {
  it("lists agents first with role, lane, live state and whether the project lets them run", async () => {
    await mount()
    const list = await screen.findByRole("list", { name: "Members" })
    const rows = within(list).getAllByRole("listitem")
    expect(rows.map((row) => row.getAttribute("data-member"))).toEqual([coder.id, reviewer.id, ada.id])
    expect(rows[0]).toHaveTextContent("Implements changes")
    expect(rows[0]).toHaveTextContent("Default")
    expect(rows[0]).toHaveTextContent("working")
    expect(rows[0]).toHaveTextContent("codex/default")
    expect(rows[0]).toHaveAttribute("data-assigned", "true")
    expect(rows[1]).toHaveTextContent("Not assigned")
    expect(rows[2]).toHaveTextContent("Director")
    expect(rows[2]).toHaveTextContent("(you)")
    expect(screen.getByRole("link", { name: "Faztudo" })).toHaveAttribute("href", "/p/faztudo")
  })

  it("assigns an agent to the project, changes the default agent and removes a member", async () => {
    const user = userEvent.setup()
    const assign = vi.spyOn(api, "assign").mockResolvedValue(org.projects[0]!)
    const patch = vi.spyOn(api, "patchChannel").mockImplementation((_id, body) => Promise.resolve({ ...dev, ...body }))
    await mount()
    await user.click(await screen.findByRole("button", { name: "Assign to Faztudo" }))
    await waitFor(() => expect(assign).toHaveBeenCalledWith("faztudo", { kind: "specialist", handle: "reviewer" }))

    await user.click(screen.getByRole("button", { name: "Make default" }))
    await waitFor(() => expect(patch).toHaveBeenCalledWith("c1", { member_ids: dev.member_ids, default_agent_id: reviewer.id }))

    await user.click(screen.getByRole("button", { name: "Remove Coder" }))
    await waitFor(() => expect(patch).toHaveBeenCalledWith("c1", { member_ids: [ada.id, reviewer.id], default_agent_id: "" }))
    expect(screen.queryByRole("button", { name: "Remove Ada" })).not.toBeInTheDocument()
  })

  it("adds a member from the ones outside", async () => {
    const user = userEvent.setup()
    const patch = vi.spyOn(api, "patchChannel").mockResolvedValue({ ...dev, member_ids: [...dev.member_ids, writer.id] })
    await mount()
    const select = await screen.findByLabelText("Add a member")
    expect(within(select).getAllByRole("option").map((option) => option.textContent)).toEqual(["Choose...", "Bob", "Writer (agent)"])
    await user.selectOptions(select, writer.id)
    await user.click(screen.getByRole("button", { name: "Add" }))
    await waitFor(() => expect(patch).toHaveBeenCalledWith("c1", { member_ids: [...dev.member_ids, writer.id] }))
  })

  it("shows the server's message when a change fails", async () => {
    const user = userEvent.setup()
    vi.spyOn(api, "assign").mockRejectedValue(new Error("only a human can change assignments"))
    await mount()
    await user.click(await screen.findByRole("button", { name: "Assign to Faztudo" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("only a human can change assignments")
  })
})

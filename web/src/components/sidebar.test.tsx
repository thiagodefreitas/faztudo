import * as Tooltip from "@radix-ui/react-tooltip"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router"
import { act, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"
import { qk } from "../state/keys"
import { setStreamStatus } from "../state/status"
import type { Approval, Channel, Lane, Member, Project, Run } from "../types"
import { AGENT_FOLD_AT, WorkspaceNav, agentActivity } from "./sidebar"

function lane(id: string, health: Lane["health"]): Lane {
  return { id, cli: "claude", cost_class: "premium", capacity: 1, running: 0, health, windows: [], runs_today: 0 }
}

function agent(n: number, presence: Member["presence"] = "offline"): Member {
  return {
    id: `01ARZ3NDEKTSV4RRFFQ69G6A${String(n).padStart(2, "0")}`,
    kind: "agent",
    handle: `bot${n}`,
    display_name: `Bot ${n}`,
    presence,
    agent: { lanes: ["claude/default"] },
  }
}

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

async function setup(options: { members?: Member[]; runs?: Run[]; projects?: Project[]; approvals?: Approval[]; channels?: Channel[]; lanes?: Lane[] } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(qk.me, ada)
  client.setQueryData(qk.members, options.members ?? [ada, bob, coder])
  client.setQueryData(qk.runs, options.runs ?? [])
  client.setQueryData(qk.channels, options.channels ?? [general, coderDm])
  client.setQueryData(qk.lanes, options.lanes ?? [])
  client.setQueryData(qk.org, { director_id: ada.id, departments: [], projects: options.projects ?? [] })
  client.setQueryData(qk.approvals, options.approvals ?? [])
  const rootRoute = createRootRoute({ component: () => <WorkspaceNav /> })
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: "/c/$channelId" }),
      createRoute({ getParentRoute: () => rootRoute, path: "/p/$handle" }),
    ]),
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
  it("hides archived projects and their channels from the rail", async () => {
    const dev: Channel = { ...general, id: "c3", name: "dev" }
    const project: Project = { handle: "old", name: "Old project", archived: true, channels: ["dev"], departments: [], specialists: [] }
    await setup({ projects: [project], channels: [general, dev, coderDm] })
    expect(screen.queryByText("Old project")).not.toBeInTheDocument()
    expect(screen.queryByText("dev")).not.toBeInTheDocument()
    expect(screen.getByText("general")).toBeInTheDocument()
  })
  it("lists each agent once and shows its unread count", async () => {
    await setup()
    expect(await screen.findAllByText("Coder")).toHaveLength(1)
    const row = screen.getByText("Coder").closest("li")
    expect(row).not.toBeNull()
    expect(within(row as HTMLElement).getByLabelText("3 unread")).toBeInTheDocument()
    expect(screen.queryByText("dm-ada-coder")).not.toBeInTheDocument()
  })

  it("marks the open channel as the current page and only that one", async () => {
    await setup()
    const open = await screen.findByRole("link", { name: /general/ })
    expect(open).toHaveAttribute("aria-current", "page")
    expect(screen.getByRole("link", { name: /Coder/ })).not.toHaveAttribute("aria-current")
    expect(screen.getByRole("link", { name: "Tasks" })).not.toHaveAttribute("aria-current")
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

  it("groups a project's channels under it and leaves the others in Channels", async () => {
    const dev: Channel = { ...general, id: "c3", name: "dev", unread: 2 }
    const project: Project = { handle: "faztudo", name: "Faztudo", channels: ["Dev"], departments: [], specialists: [] }
    await setup({ projects: [project], channels: [general, dev, coderDm] })
    const header = await screen.findByRole("link", { name: /^Faztudo/ })
    expect(header).toHaveAttribute("href", "/p/faztudo")
    const group = header.closest("[data-project]") as HTMLElement
    expect(within(group).getByText("dev")).toBeInTheDocument()
    expect(within(group).queryByText("general")).not.toBeInTheDocument()
    expect(screen.getByText("general")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "New project" })).toBeInTheDocument()
  })

  it("folds a project to one row that keeps the unread and waiting counts", async () => {
    const user = userEvent.setup()
    const dev: Channel = { ...general, id: "c3", name: "dev", unread: 2 }
    const project: Project = { handle: "faztudo", name: "Faztudo", channels: ["dev"], departments: [], specialists: [] }
    const waiting: Approval = { id: "a", run_id: "r", channel_id: "c3", requested_by: coder.id, title: "Merge", detail: "", options: [], state: "pending" }
    await setup({ projects: [project], channels: [general, dev, coderDm], approvals: [waiting] })
    const header = await screen.findByRole("link", { name: /^Faztudo/ })
    expect(within(header).getByLabelText("1 waiting for you")).toBeInTheDocument()
    expect(within(header).queryByLabelText("2 unread")).not.toBeInTheDocument()
    const group = header.closest("[data-project]") as HTMLElement
    expect(within(group).getByTestId("team-icon")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Collapse Faztudo" }))
    expect(within(group).queryByText("dev")).not.toBeInTheDocument()
    expect(within(header).getByLabelText("2 unread")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Expand Faztudo" })).toHaveAttribute("aria-expanded", "false")
  })

  it("counts the approvals that wait for me and links to the approvals inbox", async () => {
    const waiting = (id: string, state: Approval["state"]): Approval => ({
      id,
      run_id: `run-${id}`,
      channel_id: "c1",
      requested_by: coder.id,
      title: "Merge",
      detail: "",
      options: [],
      state,
    })
    await setup({ approvals: [waiting("a", "pending"), waiting("b", "pending"), waiting("c", "resolved")] })
    const link = await screen.findByRole("link", { name: /Needs you/ })
    expect(within(link).getByLabelText("2 waiting")).toBeInTheDocument()
    expect(link).toHaveAttribute("href", "/approvals")
  })

  it("keeps a quiet Needs you row without a badge when nothing waits", async () => {
    await setup()
    await screen.findByText("Coder")
    const link = screen.getByRole("link", { name: "Needs you" })
    expect(link).toHaveAttribute("href", "/approvals")
    expect(within(link).queryByLabelText(/waiting/)).not.toBeInTheDocument()
  })

  it("shows the lane summary as a compact Lanes link", async () => {
    await setup()
    const link = await screen.findByRole("link", { name: /^Lane health/ })
    expect(link).toHaveTextContent("Lanes")
    expect(link).not.toHaveTextContent("Unknown 8")
  })

  it("marks the Lanes link with the health dot, not an icon", async () => {
    await setup({ lanes: [lane("claude/default", "exhausted")] })
    const link = await screen.findByRole("link", { name: /^Lane health: Exhausted/ })
    expect(link.querySelector("svg")).toBeNull()
    expect(link.querySelector(".bg-danger")).not.toBeNull()
  })

  it("says what each agent is doing and lists agents with a run first", async () => {
    const idle = agent(1)
    const waiting = agent(2)
    const ask: Approval = { id: "a", run_id: "r", channel_id: "c1", requested_by: waiting.id, title: "Ask", detail: "", options: [], state: "pending" }
    await setup({ members: [ada, idle, waiting, coder], approvals: [ask] })
    await screen.findByText("Coder")
    const names = Array.from(document.querySelectorAll("[data-member]")).map((li) => li.getAttribute("data-member"))
    const agentIds = names.filter((id) => [idle.id, waiting.id, coder.id].includes(id ?? ""))
    expect(agentIds).toEqual([coder.id, waiting.id, idle.id])
    const state = (member: Member) => document.querySelector(`[data-member="${member.id}"] [data-activity]`)
    expect(state(coder)).toHaveTextContent("Working")
    expect(state(waiting)).toHaveTextContent("Waiting")
    expect(state(idle)).toHaveTextContent("Idle")
    expect(state(idle)).toHaveClass("opacity-0")
    expect(state(coder)).not.toHaveClass("opacity-0")
  })

  it("derives an agent's activity", () => {
    const base = agent(3)
    const none: Approval[] = []
    expect(agentActivity(base, [], none, undefined)).toBe("idle")
    expect(agentActivity(base, [], none, lane("claude/default", "exhausted"))).toBe("out of quota")
    expect(agentActivity({ ...base, presence: "busy" }, [], none, lane("claude/default", "exhausted"))).toBe("working")
    expect(agentActivity(base, [{ ...coderRun, agent_id: base.id, state: "waiting_approval" }], none, undefined)).toBe("waiting")
    expect(agentActivity(base, [{ ...coderRun, agent_id: base.id, state: "running" }], none, undefined)).toBe("working")
  })

  it("folds idle agents under Show all when there are many", async () => {
    const user = userEvent.setup()
    const many = Array.from({ length: AGENT_FOLD_AT + 2 }, (_, i) => agent(i + 1))
    await setup({ members: [ada, coder, ...many] })
    await screen.findByText("Coder")
    expect(screen.queryByText("Bot 1")).not.toBeInTheDocument()
    const more = screen.getByRole("button", { name: `Show all (${many.length})` })
    expect(more).toHaveAttribute("aria-expanded", "false")
    await user.click(more)
    expect(screen.getByText("Bot 1")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Show fewer" })).toBeInTheDocument()
  })

  it("does not fold a short agent list", async () => {
    await setup({ members: [ada, coder, agent(1), agent(2)] })
    await screen.findByText("Bot 1")
    expect(screen.queryByRole("button", { name: /^Show all/ })).not.toBeInTheDocument()
  })

  it("shows the connection only when it is not live", async () => {
    setStreamStatus("open")
    await setup()
    await screen.findByText("Coder")
    expect(screen.getByRole("status")).toBeEmptyDOMElement()
    act(() => setStreamStatus("connecting"))
    expect(screen.getByRole("status")).toHaveTextContent("Reconnecting...")
    act(() => setStreamStatus("closed"))
    expect(screen.getByRole("status")).toHaveTextContent("Offline")
    act(() => setStreamStatus("open"))
  })

  it("cycles the theme System, Light, Dark with one icon button", async () => {
    localStorage.clear()
    const user = userEvent.setup()
    await setup()
    const button = await screen.findByRole("button", { name: "Theme: System. Switch to Light." })
    await user.click(button)
    expect(screen.getByRole("button", { name: "Theme: Light. Switch to Dark." })).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Theme: Light. Switch to Dark." }))
    expect(document.documentElement.classList.contains("dark")).toBe(true)
    await user.click(screen.getByRole("button", { name: "Theme: Dark. Switch to System." }))
    expect(screen.getByRole("button", { name: "Theme: System. Switch to Light." })).toBeInTheDocument()
  })
})

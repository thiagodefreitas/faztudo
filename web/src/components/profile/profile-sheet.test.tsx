import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import * as Tooltip from "@radix-ui/react-tooltip"
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router"
import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { qk } from "../../state/keys"
import type { Channel, Member, Run } from "../../types"
import { MembersPanel } from "../members-panel"
import { MessageList } from "../message-list"
import { OrganizationPage } from "../organization"
import { WorkspaceNav } from "../sidebar"
import { ProfileSheet } from "./profile-sheet"

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count, getItemKey }: { count: number; getItemKey: (index: number) => string }) => ({
    getTotalSize: () => count * 88,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, key: getItemKey(index), start: index * 88 })),
    measureElement: () => undefined,
    scrollToIndex: () => undefined,
  }),
}))

const ada: Member = { id: "ada", kind: "human", handle: "ada", display_name: "Ada", presence: "online" }
const coder: Member = { id: "coder", kind: "agent", handle: "coder", display_name: "Coder", presence: "idle", agent: { lanes: ["codex/default"], role: "Frontend engineer", description: "Builds the web UI" } }
const channel: Channel = { id: "c1", name: "general", kind: "team", visibility: "public", member_ids: [ada.id, coder.id], unread: 0 }
const direct: Channel = { id: "dm1", name: "Ada and Coder", kind: "direct", visibility: "direct", member_ids: [ada.id, coder.id], unread: 0 }
const lane = { id: "codex/default", cli: "codex" as const, cost_class: "standard" as const, capacity: 1, running: 0, health: "available" as const, windows: [], runs_today: 0 }

afterEach(() => {
  vi.restoreAllMocks()
})

async function mount(source: "sidebar" | "members" | "message" | "organization" | "none", initial = "/", people: Member[] = [ada, coder]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(qk.me, ada)
  client.setQueryData(qk.members, people)
  client.setQueryData(qk.channels, [channel, direct])
  client.setQueryData(qk.runs, [])
  client.setQueryData(qk.approvals, [])
  client.setQueryData(qk.lanes, [lane])
  client.setQueryData(qk.org, { director_id: ada.id, departments: [{ handle: "engineering", display_name: "Engineering", lead: "coder", members: ["coder"] }], projects: [] })
  client.setQueryData(qk.lessons, [])
  client.setQueryData(qk.routines, [])
  client.setQueryData(qk.computers, [])
  client.setQueryData(qk.messages("c1"), [{ id: "m1", channel_id: "c1", author_id: coder.id, body: "Ready to work", mentions: [], created_at: new Date().toISOString() }])
  client.setQueryData(qk.messages("dm1"), [])
  client.setQueryData(qk.messagePins("c1"), [])
  client.setQueryData(qk.notices, [])
  client.setQueryData(qk.pending("c1"), [])
  const view = source === "sidebar" ? <WorkspaceNav /> : source === "members" ? <MembersPanel channel={channel} open onOpenChange={() => undefined} /> : source === "message" ? <MessageList channelId="c1" onRetry={() => undefined} /> : source === "organization" ? <OrganizationPage /> : null
  const root = createRootRoute({ component: () => <>{view}<ProfileSheet /></> })
  const router = createRouter({ routeTree: root.addChildren([
    createRoute({ getParentRoute: () => root, path: "/c/$channelId" }),
    createRoute({ getParentRoute: () => root, path: "/lanes", validateSearch: (search: Record<string, unknown>) => ({ lane: typeof search.lane === "string" ? search.lane : undefined }) }),
    createRoute({ getParentRoute: () => root, path: "/organization" }),
  ]), history: createMemoryHistory({ initialEntries: [initial] }) })
  await router.load()
  render(<QueryClientProvider client={client}><Tooltip.Provider><RouterProvider router={router} /></Tooltip.Provider></QueryClientProvider>)
  return { client, router }
}

const profileOf = (router: { state: { location: { searchStr: string } } }) => new URLSearchParams(router.state.location.searchStr).get("profile")

describe("ProfileSheet", () => {
  it.each(["sidebar", "members", "message", "organization"] as const)("opens from %s while keeping the source", async (source) => {
    const { router } = await mount(source, source === "organization" ? "/organization" : "/")
    const path = router.state.location.pathname
    const buttons = await screen.findAllByRole("button", { name: "Profile: @coder" })
    await userEvent.click(buttons[0]!)
    const dialog = await screen.findByRole("dialog", { name: "Profile" })
    expect(dialog).toHaveTextContent("Frontend engineer")
    expect(dialog).toHaveTextContent("Builds the web UI")
    expect(dialog).toHaveTextContent("Engineering")
    expect(profileOf(router)).toBe("coder")
    expect(router.state.location.pathname).toBe(path)
    await userEvent.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Profile" })).not.toBeInTheDocument())
    expect(profileOf(router)).toBeNull()
    expect(buttons[0]).toHaveFocus()
  })

  it("keeps the sidebar row click on the DM", async () => {
    const { router } = await mount("sidebar")
    await userEvent.click(await screen.findByRole("link", { name: /Coder/ }))
    await waitFor(() => expect(router.state.location.pathname).toBe("/c/dm1"))
    expect(screen.queryByRole("dialog", { name: "Profile" })).not.toBeInTheDocument()
  })

  it("opens a deep link on any route and updates when a run starts", async () => {
    const { client, router } = await mount("none", "/organization?profile=coder")
    const dialog = await screen.findByRole("dialog", { name: "Profile" })
    expect(router.state.location.pathname).toBe("/organization")
    expect(within(dialog).getByRole("region", { name: "Live state" })).toHaveTextContent("Idle")
    expect(within(dialog).getByRole("region", { name: "Lane chain" })).toHaveTextContent("Next")
    expect(within(dialog).getByRole("region", { name: "Today's runs" })).toHaveTextContent("No runs in the last 24 hours.")
    const run: Run = { id: "r1", channel_id: "c1", trigger_message_id: "m1", agent_id: coder.id, lane_id: lane.id, mode: "write", state: "running", started_at: new Date().toISOString(), cost_usd: 0.25, tokens: { input: 1000, output: 500, cache_read: 0, cache_write: 0 } }
    act(() => client.setQueryData(qk.runs, [run]))
    await waitFor(() => expect(within(dialog).getByRole("region", { name: "Live state" })).toHaveTextContent("Working"))
    expect(within(dialog).getByRole("region", { name: "Live state" })).toHaveTextContent("Ready to work in #general")
    expect(within(dialog).getByRole("region", { name: "Lane chain" })).toHaveTextContent("Running")
    const today = within(dialog).getByRole("region", { name: "Today's runs" })
    expect(today).toHaveTextContent("Today's runs (1)")
    expect(today).toHaveTextContent("Ready to work")
    expect(today).toHaveTextContent("about $0.25")
  })

  it("shows out of quota with the reset time and lessons and routines", async () => {
    const { client } = await mount("none", "/?profile=coder")
    const resets = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    act(() => {
      client.setQueryData(qk.lanes, [{ ...lane, health: "exhausted", windows: [{ name: "5h", used_pct: 100, source: "cli-log", measured_at: new Date().toISOString(), resets_at: resets }] }])
      client.setQueryData(qk.lessons, [{ id: "l1", persona: "coder", channel_id: "", text: "Run the tests", source_message_id: "", created_by: ada.id, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }])
      client.setQueryData(qk.routines, [{ handle: "nightly", name: "Nightly sweep", prompt: "Sweep", persona: "coder", channel: "general", enabled: true, source: "app" }])
    })
    const dialog = await screen.findByRole("dialog", { name: "Profile" })
    await waitFor(() => expect(within(dialog).getByRole("region", { name: "Live state" })).toHaveTextContent("Out of quota"))
    expect(within(dialog).getByRole("region", { name: "Lane chain" })).toHaveTextContent("resets")
    const extra = within(dialog).getByRole("region", { name: "Lessons and routines" })
    expect(extra).toHaveTextContent("1 lesson")
    expect(extra).toHaveTextContent("Nightly sweep")
  })

  it("shows a person with Message only", async () => {
    const grace: Member = { id: "grace", kind: "human", handle: "grace", display_name: "Grace", presence: "online" }
    await mount("none", "/?profile=grace", [ada, coder, grace])
    const dialog = await screen.findByRole("dialog", { name: "Profile" })
    expect(dialog).toHaveTextContent("Grace")
    expect(dialog).toHaveTextContent("Person")
    expect(within(dialog).getByRole("button", { name: "Message" })).toBeInTheDocument()
    expect(within(dialog).queryByRole("button", { name: "New task" })).not.toBeInTheDocument()
    expect(within(dialog).queryByRole("region", { name: "Live state" })).not.toBeInTheDocument()
  })

  it("presets New task and opens lessons from Teach", async () => {
    const { router } = await mount("none", "/?profile=coder")
    await userEvent.click(await screen.findByRole("button", { name: "New task" }))
    const task = await screen.findByRole("dialog", { name: "New task" })
    expect(within(task).getByRole("radio", { name: /Coder/ })).toBeChecked()
    expect(profileOf(router)).toBeNull()
    await userEvent.keyboard("{Escape}")
    act(() => router.history.push("/?profile=coder"))
    await userEvent.click(await screen.findByRole("button", { name: "Teach" }))
    expect(await screen.findByRole("dialog", { name: "Lessons for @coder" })).toBeInTheDocument()
  })

  it("opens the DM and the Lanes page at the agent's lane", async () => {
    const { router } = await mount("none", "/?profile=coder")
    await userEvent.click(await screen.findByRole("button", { name: "Message" }))
    await waitFor(() => expect(router.state.location.pathname).toBe("/c/dm1"))
    expect(profileOf(router)).toBeNull()
    act(() => router.history.push("/c/dm1?profile=coder"))
    await userEvent.click(await screen.findByRole("button", { name: "Open on Lanes" }))
    await waitFor(() => expect(router.state.location.pathname).toBe("/lanes"))
    expect(router.state.location.search).toEqual({ lane: "codex/default" })
  })
})

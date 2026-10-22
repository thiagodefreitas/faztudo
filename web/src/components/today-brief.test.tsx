import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it } from "vitest"
import { qk } from "../state/keys"
import type { Approval, Channel, Lane, Member, Run } from "../types"
import { TodayBrief } from "./today-brief"

const ada: Member = { id: "ada", kind: "human", handle: "ada", display_name: "Ada", presence: "online" }
const coder: Member = { id: "coder", kind: "agent", handle: "coder", display_name: "Coder", presence: "online", agent: { lanes: ["codex/default"] } }
const dev: Channel = { id: "dev", name: "dev", kind: "team", visibility: "public", member_ids: [ada.id, coder.id], unread: 0 }
const min = 60_000
const at = (ago: number) => new Date(Date.now() - ago * min).toISOString()

const runs: Run[] = [
  { id: "r1", channel_id: "dev", trigger_message_id: "m", agent_id: "coder", lane_id: "codex/default", mode: "write", state: "done", approval_option: "merge", started_at: at(30), ended_at: at(20) },
  { id: "r2", channel_id: "dev", trigger_message_id: "m", agent_id: "coder", lane_id: "claude/opus", mode: "read", state: "failed", started_at: at(15), ended_at: at(14), failure_reason: "verification failed" },
  { id: "r3", channel_id: "dev", trigger_message_id: "m", agent_id: "coder", lane_id: "codex/default", mode: "write", state: "running", started_at: at(2) },
]
const approval: Approval = { id: "a1", channel_id: "dev", requested_by: "coder", title: "Merge the patch", detail: "", options: [], state: "pending" }
const exhausted: Lane = {
  id: "grok/default",
  cli: "grok",
  cost_class: "standard",
  capacity: 1,
  running: 0,
  health: "exhausted",
  runs_today: 0,
  windows: [{ name: "5h", source: "probe", resets_at: new Date(Date.now() + 5 * 3600_000).toISOString() }],
}

async function setup(data: { runs?: Run[]; approvals?: Approval[]; lanes?: Lane[] } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(qk.me, ada)
  client.setQueryData(qk.members, [ada, coder])
  client.setQueryData(qk.channels, [dev])
  client.setQueryData(qk.messages("dev"), [])
  client.setQueryData(qk.org, { projects: [] })
  client.setQueryData(qk.runs, data.runs ?? [])
  client.setQueryData(qk.approvals, data.approvals ?? [])
  client.setQueryData(qk.lanes, data.lanes ?? [])
  const root = createRootRoute()
  const index = createRoute({ getParentRoute: () => root, path: "/", component: TodayBrief })
  const router = createRouter({ routeTree: root.addChildren([index]), history: createMemoryHistory({ initialEntries: ["/"] }) })
  await router.load()
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

afterEach(() => localStorage.clear())

describe("TodayBrief", () => {
  it("shows the quiet line when nothing waits", async () => {
    await setup()
    expect(await screen.findByText("Nothing waits for you.")).toBeInTheDocument()
    expect(screen.queryByRole("heading", { name: "Lanes" })).not.toBeInTheDocument()
  })

  it("lists what waits, what finished, what runs and which lane is short", async () => {
    await setup({ runs, approvals: [approval], lanes: [exhausted] })
    const brief = await screen.findByTestId("today")
    expect(within(brief).getByText("Merge the patch")).toBeInTheDocument()
    expect(within(brief).getByText("verification failed")).toBeInTheDocument()
    expect(within(brief).getByText("merged")).toBeInTheDocument()
    expect(within(brief).getByText("grok/default")).toBeInTheDocument()
    const running = within(brief).getByRole("heading", { name: "Running now" }).parentElement as HTMLElement
    expect(within(running).getByText("@coder")).toBeInTheDocument()
  })

  it("clears the finished list on Mark as seen and remembers it", async () => {
    await setup({ runs })
    const user = userEvent.setup()
    await user.click(await screen.findByRole("button", { name: "Mark as seen" }))
    expect(screen.queryByText("verification failed")).not.toBeInTheDocument()
    expect(screen.getByText("Nothing new.")).toBeInTheDocument()
    expect(Date.parse(localStorage.getItem("faztudo.today.seen") ?? "")).not.toBeNaN()
  })

  it("collapses and remembers the choice", async () => {
    await setup({ runs })
    const user = userEvent.setup()
    await user.click(await screen.findByRole("button", { name: /Today/ }))
    expect(screen.queryByText("Needs you")).not.toBeInTheDocument()
    expect(localStorage.getItem("faztudo.today.open")).toBe("0")
  })
})

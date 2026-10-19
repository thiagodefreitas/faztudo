import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router"
import { render, screen, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { qk } from "../state/keys"
import type { Member, Message, Run } from "../types"
import { DelegationCard } from "./delegation-card"

const cos: Member = { id: "a0", kind: "agent", handle: "cos", display_name: "Chief of Staff", presence: "busy", agent: { lanes: ["claude/default"] } }
const coder: Member = { id: "a1", kind: "agent", handle: "coder", display_name: "Coder", presence: "busy", agent: { lanes: ["codex/default"] } }
const reviewer: Member = { id: "a2", kind: "agent", handle: "reviewer", display_name: "Reviewer", presence: "online", agent: { lanes: ["kimi/default"] } }

function piece(id: string, to: string, body: string, at: string): Message {
  return {
    id,
    channel_id: "c1",
    thread_id: "m0",
    author_id: cos.id,
    body: `@${to} ${body}`,
    mentions: [],
    handoff: { request_id: "m0", from: "cos", to, depth: 1 },
    created_at: at,
  }
}

function run(id: string, trigger: string, state: Run["state"], agent = "a1"): Run {
  return {
    id,
    channel_id: "c1",
    trigger_message_id: trigger,
    agent_id: agent,
    lane_id: "codex/default",
    mode: "write",
    state,
    started_at: new Date(Date.now() - 65_000).toISOString(),
    ...(state === "done" || state === "failed" ? { ended_at: new Date(Date.now() - 5_000).toISOString() } : {}),
  }
}

const replies = [
  piece("m1", "coder", "Fix the login check\nMore detail.", "2026-10-18T10:01:00.000Z"),
  piece("m2", "reviewer", "Review the login fix", "2026-10-18T10:02:00.000Z"),
  piece("m3", "coder", "Write the changelog line", "2026-10-18T10:03:00.000Z"),
  { ...piece("m4", "reviewer", "Done.", "2026-10-18T10:04:00.000Z"), handoff: undefined },
]

async function renderCard(runs: Run[], list: Message[] = replies) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(qk.members, [cos, coder, reviewer])
  client.setQueryData(qk.runs, runs)
  const rootRoute = createRootRoute({ component: () => <DelegationCard channelId="c1" rootId="m0" replies={list} /> })
  const router = createRouter({
    routeTree: rootRoute.addChildren([createRoute({ getParentRoute: () => rootRoute, path: "/c/$channelId" })]),
    history: createMemoryHistory({ initialEntries: ["/c/c1"] }),
  })
  await router.load()
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return client
}

describe("DelegationCard", () => {
  it("lists each piece with its agent, task, state chip, time and run link", async () => {
    await renderCard([run("r1", "m1", "running"), run("r2", "m2", "done", "a2"), run("r3", "m3", "failed")])
    const card = screen.getByRole("region", { name: "Delegation" })
    expect(card).toHaveTextContent("3 pieces: 1 running, 1 done, 1 failed")
    const items = within(card).getAllByRole("listitem")
    expect(items).toHaveLength(3)
    expect(items[0]).toHaveTextContent("@coder")
    expect(items[0]).toHaveTextContent("Fix the login check")
    expect(items[0]).not.toHaveTextContent("More detail")
    expect(within(items[0]!).getByText("running")).toHaveAttribute("data-state", "running")
    // The shared clock ticks once a second, so allow the module-load offset.
    expect(items[0]).toHaveTextContent(/1m 0[0-6]s/)
    expect(items[1]).toHaveTextContent("1m 00s")
    expect(within(items[0]!).getByRole("link", { name: "Open the run of @coder" })).toHaveAttribute("href", "/c/c1?run=r1")
    expect(items[1]).toHaveTextContent("@reviewer")
    expect(within(items[1]!).getByText("done")).toBeInTheDocument()
    expect(within(items[2]!).getByText("failed")).toBeInTheDocument()
  })

  it("shows a piece without a run as not started and follows the run cache", async () => {
    const client = await renderCard([])
    const card = screen.getByRole("region", { name: "Delegation" })
    expect(card).toHaveTextContent("3 pieces: 3 not started")
    expect(within(card).queryByRole("link")).not.toBeInTheDocument()
    client.setQueryData(qk.runs, [run("r1", "m1", "waiting_approval")])
    expect(await screen.findByText("waiting approval")).toBeInTheDocument()
    expect(card).toHaveTextContent("3 pieces: 1 waiting for you, 2 not started")
  })

  it("renders nothing without handoff replies", async () => {
    await renderCard([], [replies[3]!])
    expect(screen.queryByRole("region", { name: "Delegation" })).not.toBeInTheDocument()
  })
})

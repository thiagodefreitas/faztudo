import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router"
import { render } from "@testing-library/react"
import type { ReactNode } from "react"
import { qk } from "../../state/keys"
import type { Approval, Channel, Lane, Member, Run, Task } from "../../types"

export const ada: Member = { id: "h1", kind: "human", handle: "ada", display_name: "Ada", presence: "online" }
export const coder: Member = {
  id: "a1",
  kind: "agent",
  handle: "coder",
  display_name: "Coder",
  presence: "idle",
  agent: { lanes: ["codex/default", "claude/sonnet"], role: "coder", mode: "write" },
}
export const reviewer: Member = {
  id: "a2",
  kind: "agent",
  handle: "reviewer",
  display_name: "Reviewer",
  presence: "idle",
  agent: { lanes: ["claude/sonnet"], role: "reviewer", mode: "read" },
}

export const channel: Channel = { id: "c1", name: "dev", kind: "team", visibility: "public", member_ids: ["h1", "a1", "a2"], unread: 0 }

export const lane = (id: string): Lane =>
  ({ id, cli: id.split("/")[0], health: "available", health_reason: "", windows: [], capacity: 1 }) as unknown as Lane

export const task = (id: string, status: Task["status"], over: Partial<Task> = {}): Task => ({
  id,
  channel_id: "c1",
  title: `Task ${id}`,
  assignee: "coder",
  mode: "read",
  scope: [],
  checks: [],
  acceptance: [],
  status,
  order: 1,
  run_ids: [],
  created_by: "h1",
  created_at: "2026-10-18T10:00:00Z",
  updated_at: "2026-10-18T10:00:00Z",
  ...over,
})

export const run = (id: string, over: Partial<Run> = {}): Run => ({
  id,
  channel_id: "c1",
  trigger_message_id: "m1",
  agent_id: "a1",
  lane_id: "codex/default",
  mode: "read",
  state: "done",
  ...over,
})

export interface Seed {
  tasks?: Task[]
  runs?: Run[]
  approvals?: Approval[]
}

/** Renders ui with a seeded query cache and a router that knows the channel route. */
export async function renderWithApp(ui: ReactNode, seed: Seed = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(qk.members, [ada, coder, reviewer])
  client.setQueryData(qk.channels, [channel])
  client.setQueryData(qk.lanes, [lane("codex/default"), lane("claude/sonnet")])
  client.setQueryData(qk.tasks, seed.tasks ?? [])
  client.setQueryData(qk.runs, seed.runs ?? [])
  client.setQueryData(qk.approvals, seed.approvals ?? [])
  const rootRoute = createRootRoute({ component: () => <>{ui}</> })
  const router = createRouter({
    routeTree: rootRoute.addChildren([createRoute({ getParentRoute: () => rootRoute, path: "/c/$channelId" })]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  })
  await router.load()
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { client, ...view }
}

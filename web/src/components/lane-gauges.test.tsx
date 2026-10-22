import * as Tooltip from "@radix-ui/react-tooltip"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router"
import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { qk } from "../state/keys"
import type { Lane } from "../types"
import { LaneGauges, MAX_VISIBLE_LANES, orderLanes } from "./lane-gauges"

const lanes: Lane[] = [
  {
    id: "claude/sonnet",
    cli: "claude",
    cost_class: "premium",
    capacity: 1,
    running: 0,
    health: "conserve",
    windows: [{ name: "5h", used_pct: 83, source: "cli-log", measured_at: new Date().toISOString() }],
    runs_today: 0,
  },
  {
    id: "grok/default",
    cli: "grok",
    cost_class: "standard",
    capacity: 1,
    running: 0,
    health: "available",
    windows: [{ name: "day", tokens: 48_000, source: "cli-log", measured_at: new Date().toISOString() }],
    runs_today: 0,
  },
]

async function setup(path: string, data: Lane[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(qk.lanes, data)
  const root = createRootRoute({ component: LaneGauges })
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: "/" }),
      createRoute({ getParentRoute: () => root, path: "/lanes", validateSearch: (q: Record<string, unknown>) => ({ lane: typeof q.lane === "string" ? q.lane : undefined }) }),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
  })
  await router.load()
  render(
    <QueryClientProvider client={client}>
      <Tooltip.Provider>
        <RouterProvider router={router} />
      </Tooltip.Provider>
    </QueryClientProvider>,
  )
  return router
}

describe("LaneGauges", () => {
  it("shows a gauge per lane with its health and main window, linking to that lane", async () => {
    await setup("/", lanes)
    const claude = await screen.findByRole("link", { name: "claude/sonnet: conserve, 83%" })
    expect(claude).toHaveAttribute("href", "/lanes?lane=claude%2Fsonnet")
    expect(screen.getByRole("link", { name: "grok/default: available, 48k tok" })).toBeInTheDocument()
  })

  it("offers a single phone chip with the worst health", async () => {
    await setup("/", lanes)
    const chip = await screen.findByRole("link", { name: /Lanes 1\/2/ })
    expect(chip).toHaveAttribute("href", "/lanes")
  })

  it("drops the phone chip on the Lanes page itself", async () => {
    await setup("/lanes", lanes)
    await screen.findByRole("list", { name: "Lane gauges", hidden: true })
    expect(screen.queryByRole("link", { name: /Lanes 1\/2/ })).not.toBeInTheDocument()
  })

  it("puts lanes that need attention first, worst first, then the healthy ones, unmeasured last", () => {
    const make = (id: string, health: Lane["health"]): Lane => ({ ...lanes[1], id, health })
    const order = orderLanes([make("a/ok", "available"), make("b/unknown", "unknown"), make("c/low", "conserve"), make("d/out", "exhausted"), make("0/ok", "available")])
    expect(order.map((lane) => lane.id)).toEqual(["d/out", "c/low", "0/ok", "a/ok", "b/unknown"])
  })

  it("highlights a lane that needs attention and names its health in words", async () => {
    await setup("/", lanes)
    const claude = await screen.findByRole("link", { name: "claude/sonnet: conserve, 83%" })
    expect(claude).toHaveTextContent("Conserve")
    expect(claude).toHaveClass("bg-warn-soft")
    const grok = screen.getByRole("link", { name: "grok/default: available, 48k tok" })
    expect(grok).not.toHaveTextContent("Available")
    expect(grok).not.toHaveClass("bg-warn-soft")
    const items = screen.getAllByRole("listitem", { hidden: true })
    expect(items[0]).toContainElement(claude)
  })

  it("folds lanes past the limit into +N", async () => {
    const many: Lane[] = Array.from({ length: MAX_VISIBLE_LANES + 2 }, (_, i) => ({ ...lanes[1], id: `cli/lane${i}` }))
    await setup("/", many)
    const more = await screen.findByRole("link", { name: "2 more lanes" })
    expect(more).toHaveTextContent("+2")
    expect(more).toHaveAttribute("href", "/lanes")
    expect(screen.queryByRole("link", { name: /cli\/lane7/ })).not.toBeInTheDocument()
  })

  it("renders nothing without lanes", async () => {
    const { container } = render(<div />)
    await setup("/", [])
    expect(screen.queryByRole("list", { hidden: true })).not.toBeInTheDocument()
    container.remove()
  })
})

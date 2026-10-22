import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { Lane, Run } from "../types"
import { laneRunUsage, runsTodayOf } from "../lib/lanes"
import { LaneCardView, LanesGauge } from "./lanes"

const now = Date.parse("2026-10-18T12:00:00.000Z")

const availableLane: Lane = {
  id: "codex/default",
  cli: "codex",
  cost_class: "standard",
  capacity: 2,
  running: 1,
  health: "available",
  windows: [
    {
      name: "5h",
      used_pct: 22,
      source: "cli-log",
      measured_at: new Date(now - 12 * 60_000).toISOString(),
      resets_at: new Date(now + 3 * 3_600_000 + 48 * 60_000).toISOString(),
    },
  ],
  runs_today: 3,
  tokens_last_hour: 1200,
}

const unknownLane: Lane = {
  id: "kimi/default",
  cli: "kimi",
  cost_class: "cheap",
  capacity: 1,
  running: 0,
  health: "unknown",
  windows: [{ name: "week", source: "unknown" }],
  runs_today: 0,
}

const exhaustedLane: Lane = {
  id: "grok/default",
  cli: "grok",
  model: "grok-4",
  cost_class: "standard",
  capacity: 1,
  running: 0,
  health: "exhausted",
  health_reason: "5h window is used up",
  windows: [
    {
      name: "5h",
      used_pct: 100,
      source: "error",
      measured_at: new Date(now - 5 * 60_000).toISOString(),
      resets_at: new Date(now + 55 * 60_000).toISOString(),
    },
  ],
  runs_today: 4,
  last_error: { class: "semantic", message: "usage limit reached", at: new Date(now - 5 * 60_000).toISOString() },
}

function renderCard(lane: Lane, overrides: Partial<Parameters<typeof LaneCardView>[0]> = {}) {
  const props: Parameters<typeof LaneCardView>[0] = {
    lane,
    now,
    probing: false,
    probeError: undefined,
    onProbe: () => undefined,
    ...overrides,
  }
  return render(<LaneCardView {...props} />)
}

describe("runs today", () => {
  const localDay = (at: number) => {
    const d = new Date(at)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
  }

  it("shows the count when runs_date is today's local date or missing", () => {
    expect(runsTodayOf({ ...availableLane, runs_today: 949, runs_date: localDay(now) }, now)).toBe(949)
    expect(runsTodayOf({ ...availableLane, runs_today: 3 }, now)).toBe(3)
  })

  it("hides a count from another day, on the lane card too", () => {
    const stale = { ...availableLane, runs_today: 949, runs_date: localDay(now - 3 * 86_400_000) }
    expect(runsTodayOf(stale, now)).toBeUndefined()
    renderCard(stale)
    expect(screen.queryByText("949")).not.toBeInTheDocument()
  })
})

describe("LaneCardView advice", () => {
  it("shows the next-step line under the error", () => {
    renderCard(availableLane, { advice: 'Run "codex login" in a terminal, then press Probe now.' })
    expect(screen.getByTestId("lane-advice")).toHaveTextContent('Run "codex login"')
  })

  it("shows no advice line without advice", () => {
    renderCard(availableLane)
    expect(screen.queryByTestId("lane-advice")).not.toBeInTheDocument()
  })
})

describe("LaneCardView", () => {
  it("shows percent, source and age, capacity and runs for a healthy lane", () => {
    renderCard(availableLane)
    const card = screen.getByRole("article", { name: "lane codex/default" })
    expect(card).toHaveTextContent("22%")
    expect(card).toHaveTextContent("cli-log, 12m ago")
    expect(card).toHaveTextContent("resets in 3h 48m")
    expect(card).toHaveTextContent("1 / 2")
    expect(card).toHaveTextContent("3")
    expect(card).toHaveTextContent("1,200")
    expect(screen.getByText("Available")).toBeInTheDocument()
    expect(screen.getByText("Probe now")).toBeEnabled()
  })

  it("shows history for both time ranges and measured run cost", () => {
    const history = [
      { lane_id: availableLane.id, window: { name: "5h" as const, used_pct: 10, source: "probe" as const }, read_at: new Date(now - 60_000).toISOString() },
      { lane_id: availableLane.id, window: { name: "5h" as const, used_pct: 20, source: "probe" as const }, read_at: new Date(now).toISOString() },
    ]
    const runs: Run[] = [
      { id: "a", channel_id: "c", trigger_message_id: "m", agent_id: "a", lane_id: availableLane.id, mode: "read", state: "done", started_at: new Date(now - 60_000).toISOString(), tokens: { input: 100, output: 20, cache_read: 0, cache_write: 0 }, cost_usd: 0.12 },
      { id: "b", channel_id: "c", trigger_message_id: "m", agent_id: "a", lane_id: availableLane.id, mode: "read", state: "running", started_at: new Date(now - 30_000).toISOString() },
    ]
    renderCard(availableLane, { history, runs })
    expect(screen.getByText(/Today: 120 tokens \(1 of 2 runs measured\); about \$0.12, estimate \(1 of 2 priced\)/)).toBeInTheDocument()
    expect(screen.getByRole("img", { name: "5h usage, last 24 hours" }).querySelector("path")?.getAttribute("d")).toContain("L")
    expect(screen.getByRole("img", { name: "5h usage, last 7 days" })).toBeInTheDocument()
  })

  it("filters runs by local start day and lane", () => {
    const base: Run = { id: "a", channel_id: "c", trigger_message_id: "m", agent_id: "a", lane_id: availableLane.id, mode: "read", state: "done", started_at: new Date(now).toISOString(), tokens: { input: 5, output: 1, cache_read: 0, cache_write: 0 } }
    expect(laneRunUsage([base, { ...base, id: "b", lane_id: "other" }, { ...base, id: "c", started_at: new Date(now - 2 * 86_400_000).toISOString() }], availableLane.id, now)).toEqual({ runs: 1, measured: 1, tokens: 6, priced: 0, cost: 0 })
  })

  it("shows tokens used when a lane logs tokens but has no quota percentage", () => {
    renderCard({
      ...unknownLane,
      id: "grok/default",
      cli: "grok",
      windows: [
        { name: "5h", tokens: 1_107_522, source: "cli-log", measured_at: new Date(now - 30 * 60_000).toISOString() },
        { name: "day", tokens: 4200, source: "cli-log", measured_at: new Date(now - 30 * 60_000).toISOString() },
      ],
    })
    expect(screen.getByText("1.1M tokens")).toBeInTheDocument()
    expect(screen.getByText("4.2k tokens")).toBeInTheDocument()
    expect(screen.getByRole("img", { name: "5h window 1.1M tokens used, no limit set" })).toBeInTheDocument()
  })

  it("renders unknown instead of zero for an unmeasured lane", () => {
    renderCard(unknownLane)
    const card = screen.getByRole("article", { name: "lane kimi/default" })
    expect(card).toHaveTextContent("unknown")
    expect(card).not.toHaveTextContent("0%")
    expect(card.querySelector('[data-pattern="dashed"]')).not.toBeNull()
    expect(screen.getByText("model unknown")).toBeInTheDocument()
    expect(screen.getByText("Unknown")).toBeInTheDocument()
  })

  it("shows an exhausted lane with its last error", () => {
    renderCard(exhaustedLane)
    const card = screen.getByRole("article", { name: "lane grok/default" })
    expect(card).toHaveTextContent("100%")
    expect(card).toHaveTextContent("Exhausted")
    expect(card).toHaveTextContent("usage limit reached")
    expect(card.querySelector('[data-pattern="full"]')).not.toBeNull()
    expect(card.querySelector('[data-pattern="solid"]')).toBeNull()
  })

  it("disables the probe button while probing and reports probe errors", () => {
    const { rerender } = renderCard(availableLane, { probing: true })
    expect(screen.getByRole("button", { name: "Probing..." })).toBeDisabled()
    rerender(
      <LaneCardView
        lane={availableLane}
        now={now}
        probing={false}
        probeError="cli not found"
        onProbe={() => undefined}
      />,
    )
    expect(screen.getByRole("alert")).toHaveTextContent("cli not found")
  })

  it("calls onProbe when the button is pressed", () => {
    const onProbe = vi.fn()
    renderCard(availableLane, { onProbe })
    fireEvent.click(screen.getByRole("button", { name: "Probe now" }))
    expect(onProbe).toHaveBeenCalledTimes(1)
  })
})

function renderGauge(lanes: Lane[]) {
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <LanesGauge lanes={lanes} />
        <Outlet />
      </>
    ),
  })
  const lanesRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/lanes",
    component: () => <p>lanes page</p>,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([lanesRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  })
  return router.load().then(() => {
    render(<RouterProvider router={router} />)
    return router
  })
}

describe("LanesGauge", () => {
  it("shows the worst health and the lane count and links to /lanes", async () => {
    await renderGauge([availableLane, exhaustedLane, unknownLane])
    const gauge = screen.getByRole("link", { name: "Lane health: Exhausted, 3 lanes" })
    expect(gauge).toHaveAttribute("href", "/lanes")
    expect(gauge).toHaveTextContent("Exhausted")
    expect(gauge).toHaveTextContent("3")
  })

  it("navigates to /lanes on Alt+L, but not while typing", async () => {
    const router = await renderGauge([availableLane])
    fireEvent.keyDown(window, { key: "l", altKey: true })
    await waitFor(() => expect(router.state.location.pathname).toBe("/lanes"))
    expect(screen.getByText("lanes page")).toBeInTheDocument()

    const input = document.createElement("input")
    document.body.appendChild(input)
    input.focus()
    fireEvent.keyDown(input, { key: "l", altKey: true })
    expect(router.state.location.pathname).toBe("/lanes")
    input.remove()
  })

  it("ignores the shortcut with extra modifiers", async () => {
    const router = await renderGauge([availableLane])
    fireEvent.keyDown(window, { key: "l", altKey: true, shiftKey: true })
    fireEvent.keyDown(window, { key: "l", ctrlKey: true })
    await Promise.resolve()
    expect(router.state.location.pathname).toBe("/")
  })
})

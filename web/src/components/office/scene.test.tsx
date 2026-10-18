import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router"
import { fireEvent, render, screen, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { Approval, Channel, Lane, Member, Run } from "../../types"
import { OfficeScene, type OfficeSceneProps } from "./scene"
import { deriveOfficeDesks } from "./state"

const now = Date.parse("2026-10-18T12:00:00.000Z")

const members: Member[] = [
  {
    id: "m-director",
    kind: "human",
    handle: "director",
    display_name: "Thiago Director",
    presence: "online",
  },
  {
    id: "m-claude",
    kind: "agent",
    handle: "claude",
    display_name: "Claude",
    presence: "busy",
    agent: { lanes: ["claude/opus"], role: "architect", mode: "write" },
  },
  {
    id: "m-codex",
    kind: "agent",
    handle: "codex",
    display_name: "Codex",
    presence: "online",
    agent: { lanes: ["codex/default"], role: "coder", mode: "write" },
  },
  {
    id: "m-grok",
    kind: "agent",
    handle: "grok",
    display_name: "Grok",
    presence: "offline",
    agent: { lanes: ["grok/default"], role: "reviewer", mode: "read" },
  },
  {
    id: "m-coder",
    kind: "agent",
    handle: "coder",
    display_name: "Coder",
    presence: "online",
    agent: { lanes: ["codex/default"], role: "coder", mode: "write" },
  },
]

const lanes: Lane[] = [
  {
    id: "claude/opus",
    cli: "claude",
    model: "claude-opus-4",
    cost_class: "premium",
    capacity: 2,
    running: 1,
    health: "available",
    windows: [
      {
        name: "5h",
        used_pct: 40,
        source: "cli-log",
        measured_at: new Date(now - 3 * 60_000).toISOString(),
      },
    ],
    runs_today: 5,
  },
  {
    id: "codex/default",
    cli: "codex",
    model: "codex-1",
    cost_class: "standard",
    capacity: 1,
    running: 1,
    health: "conserve",
    windows: [{ name: "5h", used_pct: 82, source: "probe" }],
    runs_today: 6,
  },
  {
    id: "grok/default",
    cli: "grok",
    model: "grok-4",
    cost_class: "standard",
    capacity: 1,
    running: 0,
    health: "exhausted",
    health_reason: "5h window exhausted",
    windows: [{ name: "5h", used_pct: 100, source: "error" }],
    runs_today: 8,
  },
]

const runs: Run[] = [
  {
    id: "run-working",
    channel_id: "ch-build",
    trigger_message_id: "msg-1",
    agent_id: "m-claude",
    lane_id: "claude/opus",
    mode: "write",
    state: "running",
    started_at: new Date(now - 95_000).toISOString(),
  },
  {
    id: "run-approval",
    channel_id: "ch-ship",
    trigger_message_id: "msg-2",
    agent_id: "m-codex",
    lane_id: "codex/default",
    mode: "write",
    state: "waiting_approval",
    started_at: new Date(now - 180_000).toISOString(),
  },
]

const approvals: Approval[] = [
  {
    id: "app-ship",
    run_id: "run-approval",
    channel_id: "ch-ship",
    requested_by: "m-codex",
    title: "Approve migration commit",
    detail: "Adds office route",
    options: [{ key: "merge", label: "Merge", style: "primary" }],
    state: "pending",
  },
]

const channels: Channel[] = [
  {
    id: "ch-build",
    name: "build",
    kind: "project",
    visibility: "public",
    member_ids: ["m-director", "m-claude"],
    unread: 0,
  },
  {
    id: "ch-ship",
    name: "ship",
    kind: "project",
    visibility: "public",
    member_ids: ["m-director", "m-codex"],
    unread: 1,
  },
]

async function renderScene(overrides: Partial<OfficeSceneProps> = {}) {
  const desks = deriveOfficeDesks({ members, runs, approvals, lanes, now })
  const props: OfficeSceneProps = {
    desks,
    channels,
    now,
    reducedMotion: true,
    ...overrides,
  }
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <OfficeScene {...props} />
        <Outlet />
      </>
    ),
  })
  const channelRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/c/$channelId",
    component: () => <p>channel view</p>,
  })
  const lanesRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/lanes",
    component: () => <p>lanes view</p>,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([channelRoute, lanesRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  })
  await router.load()
  render(<RouterProvider router={router} />)
  return router
}

describe("OfficeScene", () => {
  it("renders accessible desk buttons, states, side panel details, and approval/DM actions", async () => {
    const onOpenApproval = vi.fn()
    const onMessage = vi.fn()
    await renderScene({ onOpenApproval, onMessage })

    // Accessible desk buttons with name and state
    const directorBtn = screen.getByRole("button", { name: "Thiago Director, idle" })
    const claudeBtn = screen.getByRole("button", { name: "Claude, working, elapsed 1m 35s" })
    const codexBtn = screen.getByRole("button", { name: "Codex, waiting for approval" })
    const grokBtn = screen.getByRole("button", { name: "Grok, out of quota" })

    expect(directorBtn).toHaveAttribute("data-director", "true")
    expect(claudeBtn).toHaveAttribute("data-state", "working")
    expect(codexBtn).toHaveAttribute("data-state", "waiting_approval")
    expect(screen.getByTestId("monitor-glow-m-claude")).toBeInTheDocument()
    expect(screen.getByTestId("elapsed-m-claude")).toHaveTextContent("1m 35s")
    expect(grokBtn).toHaveAttribute("data-out-of-quota", "true")
    expect(screen.getByTestId("quota-tag-m-grok")).toHaveTextContent("out of quota")

    // Clicking the raised-hand badge opens the channel at that approval
    fireEvent.click(screen.getByTestId("raised-hand-badge-m-codex"))
    expect(onOpenApproval).toHaveBeenCalledTimes(1)
    expect(onOpenApproval.mock.calls[0]?.[0]?.approvalChannelId).toBe("ch-ship")

    // Clicking a desk opens the side panel with member, lane/health, current run, and Message button
    fireEvent.click(claudeBtn)
    const panel = screen.getByRole("complementary", { name: "Claude details" })
    expect(panel).toHaveTextContent("claude/opus")
    expect(panel).toHaveTextContent("Available")
    expect(panel).toHaveTextContent("Running")
    expect(panel).toHaveTextContent("Open in #build")

    fireEvent.click(screen.getByRole("button", { name: "Message" }))
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ id: "m-claude" }))
  })

  it("draws one room with labeled pod areas, a legend and desks in reading order", async () => {
    await renderScene()

    expect(screen.getAllByRole("group", { name: "Office floor plan" })).toHaveLength(1)
    expect(within(screen.getByTestId("zone-personas")).getByText("Personas")).toBeInTheDocument()
    expect(within(screen.getByTestId("zone-agents")).getByText("Agents")).toBeInTheDocument()
    expect(within(screen.getByRole("list", { name: "Legend" })).getAllByRole("listitem")).toHaveLength(4)

    const order = screen.getAllByRole("button").map((button) => button.getAttribute("data-testid"))
    expect(order.slice(0, 5)).toEqual(["desk-m-coder", "desk-m-claude", "desk-m-codex", "desk-m-grok", "desk-m-director"])
  })

  it("selects a desk with the keyboard", async () => {
    await renderScene()

    const codex = screen.getByRole("button", { name: "Codex, waiting for approval" })
    codex.focus()
    fireEvent.keyDown(codex, { key: "Enter" })
    expect(codex).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByRole("complementary", { name: "Codex details" })).toBeInTheDocument()
  })
})

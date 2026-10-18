import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router"
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { Channel, Member } from "../../../types"
import { deriveOfficeDesks } from "../state"
import { Office3DScene, type Office3DSceneProps } from "./scene3d"

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
    presence: "online",
    agent: { lanes: ["claude/opus"], role: "architect", mode: "write" },
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

const channels: Channel[] = [
  {
    id: "ch-general",
    name: "general",
    kind: "team",
    visibility: "public",
    member_ids: ["m-director", "m-claude", "m-coder"],
    unread: 0,
  },
]

async function renderScene3D(overrides: Partial<Office3DSceneProps> = {}) {
  const desks = deriveOfficeDesks({ members, runs: [], approvals: [], lanes: [], now })
  const props: Office3DSceneProps = {
    desks,
    channels,
    now,
    reducedMotion: true,
    webglAvailable: false,
    ...overrides,
  }
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <Office3DScene {...props} />
        <Outlet />
      </>
    ),
  })
  const lanesRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/lanes",
    component: () => <p>lanes view</p>,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([lanesRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  })
  await router.load()
  render(<RouterProvider router={router} />)
  return router
}

describe("Office3DScene", () => {
  it("renders the static fallback when WebGL is unavailable and opens the side panel when a desk is selected", async () => {
    const onMessage = vi.fn()
    await renderScene3D({ onMessage })

    const fallback = screen.getByTestId("office3d-fallback")
    expect(fallback).toHaveTextContent("3D view is unavailable because WebGL could not be initialized on this device.")

    const claudeBtn = screen.getByTestId("fallback-desk-m-claude")
    fireEvent.click(claudeBtn)

    const panel = screen.getByRole("complementary", { name: "Claude details" })
    expect(panel).toHaveTextContent("@claude")

    fireEvent.click(screen.getByRole("button", { name: "Message" }))
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ id: "m-claude" }))
  })
})

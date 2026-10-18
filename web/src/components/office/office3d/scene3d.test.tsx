import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router"
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { Channel, Department, Member } from "../../../types"
import { layoutRoom } from "../layout"
import { deriveOfficeDesks } from "../state"
import { defaultCameraPose, Office3DScene, type Office3DSceneProps, SCENE_PALETTES, toWorld } from "./scene3d"

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

const departments: Department[] = [
  {
    handle: "eng",
    display_name: "Engineering",
    lead: "claude",
    members: ["coder"],
  },
]

async function renderScene3D(overrides: Partial<Office3DSceneProps> = {}) {
  const desks = deriveOfficeDesks({ members, runs: [], approvals: [], lanes: [], now })
  const props: Office3DSceneProps = {
    desks,
    channels,
    departments,
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
  it("renders the static fallback when WebGL is unavailable, shows every desk name including Coder, department labels, reset-view button, and opens the side panel", async () => {
    const onMessage = vi.fn()
    await renderScene3D({ onMessage })

    const fallback = screen.getByTestId("office3d-fallback")
    expect(fallback).toHaveTextContent("3D view is unavailable because WebGL could not be initialized on this device.")

    expect(screen.getByTestId("office3d-reset-view")).toHaveTextContent("Reset view")
    expect(screen.getByTestId("fallback-zone-dept-eng")).toHaveTextContent("Engineering")
    expect(screen.getByTestId("fallback-desk-m-coder")).toHaveTextContent("Coder")
    expect(screen.getByTestId("fallback-desk-m-director")).toHaveTextContent("Thiago Director")

    const claudeBtn = screen.getByTestId("fallback-desk-m-claude")
    fireEvent.click(claudeBtn)

    const panel = screen.getByRole("complementary", { name: "Claude details" })
    expect(panel).toHaveTextContent("@claude")

    fireEvent.click(screen.getByRole("button", { name: "Message" }))
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ id: "m-claude" }))
  })

  it("computes a room-framing defaultCameraPose and world coordinates for both light and dark themes", () => {
    const desks = deriveOfficeDesks({ members, runs: [], approvals: [], lanes: [], now })
    const room = layoutRoom(desks, { departments })
    const pose = defaultCameraPose(room.width, room.height)

    expect(pose.position[0]).toBe(0)
    expect(pose.position[1]).toBeGreaterThan(8)
    expect(pose.position[2]).toBeGreaterThan(10)
    expect(pose.target).toEqual([0, 0.2, 0.3])

    const centered = toWorld({ x: room.width / 2 - 50, y: room.height / 2 - 50, w: 100, h: 100 }, room.width, room.height)
    expect(centered.x).toBeCloseTo(0)
    expect(centered.z).toBeCloseTo(0)

    expect(SCENE_PALETTES.light.surface).not.toBe(SCENE_PALETTES.light.line)
    expect(SCENE_PALETTES.dark.surface).not.toBe(SCENE_PALETTES.dark.line)
    expect(SCENE_PALETTES.dark.hemiIntensity).toBeGreaterThan(1)
  })
})

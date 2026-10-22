import { createMemoryHistory, createRootRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router"
import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Channel, Department, Member } from "../../types"
import { OfficeScene, type OfficeSceneProps } from "./scene"
import { deriveOfficeDesks } from "./state"

const now = Date.parse("2026-10-18T12:00:00.000Z")

function agent(id: string, handle: string, role: string): Member {
  return {
    id,
    kind: "agent",
    handle,
    display_name: handle,
    presence: "online",
    agent: { lanes: ["codex/default"], role, mode: "write" },
  }
}

const baseMembers: Member[] = [
  { id: "m-director", kind: "human", handle: "director", display_name: "Director", presence: "online" },
  agent("m-coder", "coder", "coder"),
  agent("m-architect", "architect", "architect"),
  agent("m-writer", "writer", "writer"),
]

const channels: Channel[] = []

const departments: Department[] = [
  { handle: "eng", display_name: "Engineering", lead: "architect", members: ["coder"] },
  { handle: "docs", display_name: "Docs", lead: "writer", members: [] },
]

async function renderScene(overrides: Partial<OfficeSceneProps> = {}, members: Member[] = baseMembers) {
  const desks = deriveOfficeDesks({ members, runs: [], approvals: [], lanes: [], now })
  const props: OfficeSceneProps = { desks, channels, departments, now, reducedMotion: true, ...overrides }
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <OfficeScene {...props} />
        <Outlet />
      </>
    ),
  })
  const router = createRouter({ routeTree: rootRoute.addChildren([]), history: createMemoryHistory({ initialEntries: ["/"] }) })
  await router.load()
  return render(<RouterProvider router={router} />)
}

const room = () => screen.getByTestId("office-room")
const svg = () => screen.getByRole("group", { name: "Office floor plan" })
const zoom = () => Number(room().getAttribute("data-zoom"))
const viewBox = () => (svg().getAttribute("viewBox") ?? "").split(" ").map(Number) as [number, number, number, number]

beforeEach(() => sessionStorage.clear())
afterEach(() => sessionStorage.clear())

describe("OfficeScene zoom", () => {
  it("starts at fit-all with the whole room in the viewBox", async () => {
    await renderScene()
    expect(zoom()).toBe(1)
    const [x, y] = viewBox()
    expect([x, y]).toEqual([0, 0])
    expect(screen.getByRole("button", { name: "Zoom out" })).toBeDisabled()
  })

  it("zooms with the buttons and returns with Fit all", async () => {
    await renderScene()
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }))
    expect(zoom()).toBeGreaterThan(1)
    const [, , w] = viewBox()
    expect(w).toBeLessThan(1200)
    fireEvent.click(screen.getByRole("button", { name: "Fit all" }))
    expect(zoom()).toBe(1)
  })

  it("zooms with + and - and fits with 0 when the room has focus, and arrows pan once zoomed", async () => {
    await renderScene()
    room().focus()
    fireEvent.keyDown(room(), { key: "+" })
    fireEvent.keyDown(room(), { key: "+" })
    const zoomed = zoom()
    expect(zoomed).toBeGreaterThan(1.5)
    fireEvent.keyDown(room(), { key: "-" })
    expect(zoom()).toBeLessThan(zoomed)
    fireEvent.keyDown(room(), { key: "+" })
    const [x0] = viewBox()
    fireEvent.keyDown(room(), { key: "ArrowRight" })
    expect(viewBox()[0]).toBeGreaterThan(x0)
    fireEvent.keyDown(room(), { key: "0" })
    expect(zoom()).toBe(1)
  })

  it("leaves the arrow keys to the browser at fit-all", async () => {
    await renderScene()
    const notCancelled = fireEvent.keyDown(room(), { key: "ArrowDown" })
    expect(notCancelled).toBe(true)
  })

  it("returns to fit-all on Escape when nothing else is open", async () => {
    await renderScene()
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }))
    expect(zoom()).toBeGreaterThan(1)
    fireEvent.keyDown(window, { key: "Escape" })
    expect(zoom()).toBe(1)
  })

  it("closes the desk panel first on Escape and keeps the zoom", async () => {
    await renderScene()
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }))
    fireEvent.click(screen.getByTestId("desk-m-coder"))
    expect(screen.getByRole("complementary")).toBeInTheDocument()
    fireEvent.keyDown(window, { key: "Escape" })
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument()
    expect(zoom()).toBeGreaterThan(1)
    fireEvent.keyDown(window, { key: "Escape" })
    expect(zoom()).toBe(1)
  })

  it("zooms the mouse wheel around the pointer and stays inside the room", async () => {
    await renderScene()
    fireEvent.wheel(room(), { deltaY: -100, clientX: 0, clientY: 0 })
    const once = zoom()
    expect(once).toBeGreaterThan(1)
    const [x, y] = viewBox()
    expect(x).toBeGreaterThanOrEqual(0)
    expect(y).toBeGreaterThanOrEqual(0)
    for (let i = 0; i < 40; i += 1) fireEvent.wheel(room(), { deltaY: -100 })
    expect(zoom()).toBe(4)
    for (let i = 0; i < 80; i += 1) fireEvent.wheel(room(), { deltaY: 100 })
    expect(zoom()).toBe(1)
  })

  function jumpTo(label: string) {
    const menu = screen.getByRole("combobox", { name: "Jump to area" })
    fireEvent.focus(menu)
    fireEvent.mouseDown(within(screen.getByRole("listbox", { name: "Areas" })).getByRole("option", { name: label }))
    return menu
  }

  it("lists the zones and the Director in the jump menu and zooms to the chosen one", async () => {
    await renderScene()
    const menu = screen.getByRole("combobox", { name: "Jump to area" })
    fireEvent.focus(menu)
    const options = within(screen.getByRole("listbox", { name: "Areas" })).getAllByRole("option").map((o) => o.textContent)
    expect(options).toEqual(["Engineering", "Docs", "Director"])

    fireEvent.mouseDown(screen.getByRole("option", { name: "Docs" }))
    expect(zoom()).toBeGreaterThan(1)
    expect(menu).toHaveValue("")

    fireEvent.click(screen.getByRole("button", { name: "Fit all" }))
    jumpTo("Director")
    expect(zoom()).toBeGreaterThan(1)
  })

  it("filters the jump list as the query is typed", async () => {
    await renderScene()
    const menu = screen.getByRole("combobox", { name: "Jump to area" })
    fireEvent.change(menu, { target: { value: "doc" } })
    const options = within(screen.getByRole("listbox", { name: "Areas" })).getAllByRole("option").map((o) => o.textContent)
    expect(options).toEqual(["Docs"])
    fireEvent.change(menu, { target: { value: "zzz" } })
    expect(screen.getByText("No matches")).toBeInTheDocument()
    expect(screen.queryByRole("option")).not.toBeInTheDocument()
  })

  it("frames the chosen zone with a margin", async () => {
    await renderScene()
    jumpTo("Docs")
    const [x, y, w, h] = viewBox()
    const zone = screen.getByTestId("zone-dept-docs").querySelector("rect")
    const zx = Number(zone?.getAttribute("x"))
    const zy = Number(zone?.getAttribute("y"))
    const zw = Number(zone?.getAttribute("width"))
    const zh = Number(zone?.getAttribute("height"))
    expect(x).toBeLessThanOrEqual(zx)
    expect(y).toBeLessThanOrEqual(zy)
    expect(x + w).toBeGreaterThanOrEqual(zx + zw)
    expect(y + h).toBeGreaterThanOrEqual(zy + zh)
  })

  it("zooms to an area from its name with Enter or Space, and from a click on its floor", async () => {
    await renderScene()
    const label = screen.getByRole("button", { name: "Zoom to Engineering" })
    label.focus()
    fireEvent.keyDown(label, { key: "Enter" })
    expect(zoom()).toBeGreaterThan(1)

    fireEvent.click(screen.getByRole("button", { name: "Fit all" }))
    fireEvent.keyDown(screen.getByRole("button", { name: "Zoom to Docs" }), { key: " " })
    expect(zoom()).toBeGreaterThan(1)

    fireEvent.click(screen.getByRole("button", { name: "Fit all" }))
    fireEvent.click(screen.getByTestId("zone-dept-eng").querySelector("rect") as Element)
    expect(zoom()).toBeGreaterThan(1)

    fireEvent.click(screen.getByRole("button", { name: "Fit all" }))
    const pod = screen.getByTestId("zone-dept-eng").querySelector("g rect") as Element
    fireEvent.click(pod)
    const podZoom = zoom()
    expect(podZoom).toBeGreaterThan(1)
  })

  it("keeps the desks first in the tab order and still opens a desk on click", async () => {
    await renderScene()
    const first = screen.getAllByRole("button")[0]
    expect(first?.getAttribute("data-testid")).toMatch(/^desk-/)
    fireEvent.click(screen.getByTestId("desk-m-writer"))
    expect(screen.getByRole("complementary", { name: "writer details" })).toBeInTheDocument()
  })

  it("remembers the view for the session and restores it on the next mount", async () => {
    const first = await renderScene()
    jumpTo("Docs")
    const remembered = zoom()
    const box = viewBox()
    first.unmount()

    await renderScene()
    expect(zoom()).toBeCloseTo(remembered, 1)
    expect(viewBox()[0]).toBeCloseTo(box[0], 1)
    expect(viewBox()[1]).toBeCloseTo(box[1], 1)
  })

  it("resets the remembered view when a desk is added", async () => {
    const first = await renderScene()
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }))
    first.unmount()

    await renderScene({}, [...baseMembers, agent("m-new", "newbie", "reviewer")])
    expect(zoom()).toBe(1)
  })

  it("resets the view when desks change under a mounted room", async () => {
    const desks = deriveOfficeDesks({ members: baseMembers, runs: [], approvals: [], lanes: [], now })
    const more = deriveOfficeDesks({ members: [...baseMembers, agent("m-new", "newbie", "reviewer")], runs: [], approvals: [], lanes: [], now })
    const rootRoute = createRootRoute({ component: () => <Outlet /> })
    const router = createRouter({ routeTree: rootRoute.addChildren([]), history: createMemoryHistory({ initialEntries: ["/"] }) })
    await router.load()
    const make = (list: typeof desks) => (
      <RouterProvider router={router} context={{}} defaultPendingComponent={() => null} InnerWrap={({ children }) => (
        <>
          <OfficeScene desks={list} channels={channels} departments={departments} now={now} reducedMotion />
          {children}
        </>
      )} />
    )
    const view = render(make(desks))
    await act(async () => {})
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }))
    expect(zoom()).toBeGreaterThan(1)
    view.rerender(make(more))
    await act(async () => {})
    expect(zoom()).toBe(1)
  })
})

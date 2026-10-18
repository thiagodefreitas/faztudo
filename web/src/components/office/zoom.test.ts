import { describe, expect, it } from "vitest"
import { layoutRoom, roomAreas } from "./layout"
import {
  clampState,
  fitState,
  isFit,
  layoutSignature,
  lerpState,
  loadView,
  mapZoomKey,
  MAX_ZOOM,
  panState,
  saveView,
  stateForRect,
  viewGeometry,
  viewRect,
  wheelFactor,
  zoomAround,
} from "./zoom"

// A 1200 x 600 room in a viewport of the same shape.
const g = viewGeometry(1200, 600, 2, false)

describe("view geometry", () => {
  it("fits a room into a wider viewport, centered and top-aligned", () => {
    const wide = viewGeometry(1200, 600, 3, false)
    expect(wide.base).toEqual({ x: -300, y: 0, w: 1800, h: 600 })
    expect(wide.bounds).toEqual(wide.base)
  })

  it("fits a room into a taller viewport by width", () => {
    const tall = viewGeometry(1200, 600, 1, false)
    expect(tall.base).toEqual({ x: 0, y: 0, w: 1200, h: 1200 })
  })

  it("keeps a phone room as wide as the viewport and lets bounds cover the whole room", () => {
    const phone = viewGeometry(390, 1500, 0.65, true)
    expect(phone.base.w).toBe(390)
    expect(phone.base.h).toBeCloseTo(600, 0)
    expect(phone.bounds).toEqual({ x: 0, y: 0, w: 390, h: 1500 })
  })

  it("falls back to the room's own shape for a bad aspect", () => {
    expect(viewGeometry(1200, 600, 0, false).base).toEqual({ x: 0, y: 0, w: 1200, h: 600 })
    expect(viewGeometry(1200, 600, Number.NaN, false).base).toEqual({ x: 0, y: 0, w: 1200, h: 600 })
  })
})

describe("clamp", () => {
  it("fit-all is zoom 1 centered, and any pan at zoom 1 snaps back", () => {
    const fit = fitState(g)
    expect(fit).toEqual({ zoom: 1, cx: 600, cy: 300 })
    expect(isFit(fit)).toBe(true)
    expect(clampState({ zoom: 1, cx: 10, cy: 10 }, g)).toEqual(fit)
  })

  it("limits zoom between fit-all and 4x", () => {
    expect(clampState({ zoom: 0.2, cx: 0, cy: 0 }, g).zoom).toBe(1)
    expect(clampState({ zoom: 9, cx: 600, cy: 300 }, g).zoom).toBe(MAX_ZOOM)
    expect(clampState({ zoom: Number.NaN, cx: 600, cy: 300 }, g).zoom).toBe(1)
  })

  it("keeps the window inside the room", () => {
    const state = clampState({ zoom: 2, cx: -500, cy: 9000 }, g)
    const rect = viewRect(state, g)
    expect(rect.x).toBeCloseTo(0)
    expect(rect.y + rect.h).toBeCloseTo(600)
    expect(rect.w).toBeCloseTo(600)
  })
})

describe("zoom around a point", () => {
  it("keeps the point under the pointer fixed", () => {
    const fit = fitState(g)
    // The pointer sits at 25% across and 50% down: room point (300, 300).
    const next = zoomAround(fit, g, 2, 0.25, 0.5)
    const rect = viewRect(next, g)
    expect(next.zoom).toBe(2)
    expect(rect.x + 0.25 * rect.w).toBeCloseTo(300)
    expect(rect.y + 0.5 * rect.h).toBeCloseTo(300)
  })

  it("never goes past 4x or below fit-all", () => {
    let state = fitState(g)
    for (let i = 0; i < 10; i += 1) state = zoomAround(state, g, 2, 0.5, 0.5)
    expect(state.zoom).toBe(MAX_ZOOM)
    for (let i = 0; i < 10; i += 1) state = zoomAround(state, g, 0.5, 0.5, 0.5)
    expect(isFit(state)).toBe(true)
  })

  it("zooming out from a corner returns to fit-all", () => {
    const corner = zoomAround(fitState(g), g, 4, 0, 0)
    expect(viewRect(corner, g).x).toBeCloseTo(0)
    expect(isFit(zoomAround(corner, g, 0.25, 0, 0))).toBe(true)
  })
})

describe("pan", () => {
  it("moves the window and stops at the room's edge", () => {
    const zoomed = { zoom: 2, cx: 600, cy: 300 }
    expect(panState(zoomed, g, 100, 0).cx).toBe(700)
    expect(panState(zoomed, g, 5000, 0).cx).toBe(900)
    expect(panState(zoomed, g, -5000, 0).cx).toBe(300)
  })
})

describe("fit a rect into the viewport", () => {
  it("fills the window with a margin and centers the rect", () => {
    const rect = { x: 100, y: 100, w: 400, h: 200 }
    const state = stateForRect(rect, g, 20)
    expect(state.zoom).toBeCloseTo(Math.min(1200 / 440, 600 / 240))
    const view = viewRect(state, g)
    expect(view.x).toBeLessThanOrEqual(rect.x - 20 + 1e-6)
    expect(view.x + view.w).toBeGreaterThanOrEqual(rect.x + rect.w + 20 - 1e-6)
    expect(view.y).toBeLessThanOrEqual(rect.y - 20 + 1e-6)
    expect(view.y + view.h).toBeGreaterThanOrEqual(rect.y + rect.h + 20 - 1e-6)
  })

  it("caps a small rect at 4x and a huge one at fit-all", () => {
    expect(stateForRect({ x: 500, y: 250, w: 20, h: 20 }, g).zoom).toBe(MAX_ZOOM)
    expect(isFit(stateForRect({ x: 0, y: 0, w: 5000, h: 5000 }, g))).toBe(true)
  })
})

describe("animation", () => {
  it("starts at the old view, ends at the new one and eases in between", () => {
    const from = fitState(g)
    const to = { zoom: 4, cx: 200, cy: 100 }
    expect(lerpState(from, to, 0)).toEqual(from)
    expect(lerpState(from, to, 1)).toEqual(to)
    const mid = lerpState(from, to, 0.5)
    expect(mid.zoom).toBeCloseTo(2)
    expect(mid.cx).toBeCloseTo(400)
  })
})

describe("input mapping", () => {
  it("turns a wheel up into zoom in, down into zoom out, and pinch into a bigger gain", () => {
    expect(wheelFactor(-100, 0, false)).toBeGreaterThan(1)
    expect(wheelFactor(100, 0, false)).toBeLessThan(1)
    expect(wheelFactor(-10, 0, true)).toBeGreaterThan(wheelFactor(-10, 0, false))
    expect(wheelFactor(-5, 1, false)).toBeCloseTo(wheelFactor(-80, 0, false))
    expect(wheelFactor(-100000, 0, false)).toBe(wheelFactor(-240, 0, false))
  })

  it("maps the keys and leaves chords to the browser", () => {
    expect(mapZoomKey({ key: "+" })).toMatchObject({ type: "zoom" })
    expect(mapZoomKey({ key: "=" })).toMatchObject({ type: "zoom" })
    expect(mapZoomKey({ key: "-" })).toMatchObject({ type: "zoom" })
    expect(mapZoomKey({ key: "0" })).toEqual({ type: "fit" })
    expect(mapZoomKey({ key: "ArrowLeft" })).toMatchObject({ type: "pan", dx: expect.any(Number) })
    expect(mapZoomKey({ key: "+", ctrlKey: true })).toBeNull()
    expect(mapZoomKey({ key: "a" })).toBeNull()
  })
})

describe("session memory", () => {
  function fakeStorage() {
    const data = new Map<string, string>()
    return {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
    }
  }

  it("restores the saved view for the same layout only", () => {
    const store = fakeStorage()
    const state = { zoom: 2.5, cx: 400, cy: 250 }
    saveView(store, "layout-a", state)
    expect(loadView(store, "layout-a")).toEqual(state)
    expect(loadView(store, "layout-b")).toBeNull()
  })

  it("ignores broken data and a missing or throwing store", () => {
    const store = fakeStorage()
    store.setItem("faztudo.office.view", "{nope")
    expect(loadView(store, "x")).toBeNull()
    store.setItem("faztudo.office.view", JSON.stringify({ sig: "x", state: { zoom: "big" } }))
    expect(loadView(store, "x")).toBeNull()
    expect(loadView(null, "x")).toBeNull()
    expect(() => saveView(null, "x", fitState(g))).not.toThrow()
    const full = { setItem: () => { throw new Error("quota") } }
    expect(() => saveView(full, "x", fitState(g))).not.toThrow()
  })

  it("changes the layout signature when a desk is added or removed or the width changes", () => {
    const a = layoutSignature(1200, 600, ["m1", "m2"])
    expect(layoutSignature(1200, 600, ["m2", "m1"])).toBe(a)
    expect(layoutSignature(1200, 600, ["m1", "m2", "m3"])).not.toBe(a)
    expect(layoutSignature(1200, 600, ["m1"])).not.toBe(a)
    expect(layoutSignature(390, 600, ["m1", "m2"])).not.toBe(a)
  })
})

describe("room areas", () => {
  it("lists each zone and then the Director rug", () => {
    const room = layoutRoom([])
    expect(roomAreas(room)).toEqual([])
    const withRug = roomAreas({ zones: [{ id: "z", label: "Zone", x: 1, y: 2, w: 3, h: 4, pods: [] }], rug: { x: 5, y: 6, w: 7, h: 8 } })
    expect(withRug.map((a) => a.id)).toEqual(["z", "director"])
    expect(withRug[1]).toMatchObject({ label: "Director", x: 5, y: 6, w: 7, h: 8 })
  })
})

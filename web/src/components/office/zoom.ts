import type { Rect } from "./layout"

// Zoom and pan for the 2D room. The picture is one SVG, so a view is a window
// onto it expressed in room units and applied through the viewBox. Text stays
// sharp because the browser re-rasterizes the SVG at every zoom level.
//
// A view is a zoom factor and a center. Zoom 1 is "fit all".

export const MIN_ZOOM = 1
export const MAX_ZOOM = 4
export const ZOOM_STEP = 1.4
export const PAN_STEP = 0.15
export const AREA_MARGIN = 24
export const ANIMATION_MS = 300

export interface ViewState {
  zoom: number
  cx: number
  cy: number
}

export interface ViewGeometry {
  // The window at zoom 1. It has the aspect of the viewport.
  base: Rect
  // The most the window may show: the room plus whatever the base adds around it.
  bounds: Rect
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }
}

// aspect is the viewport width over its height. Wide rooms are contained in the
// viewport and centered across, top-aligned, like the SVG's xMidYMin meet. On
// phones the base is as wide as the room and the room scrolls when not zoomed.
export function viewGeometry(roomW: number, roomH: number, aspect: number, compact: boolean): ViewGeometry {
  const a = aspect > 0 && Number.isFinite(aspect) ? aspect : roomW / roomH
  let base: Rect
  if (compact || a < roomW / roomH) base = { x: 0, y: 0, w: roomW, h: roomW / a }
  else base = { x: (roomW - roomH * a) / 2, y: 0, w: roomH * a, h: roomH }
  return { base, bounds: union(base, { x: 0, y: 0, w: roomW, h: roomH }) }
}

export function fitState(g: ViewGeometry): ViewState {
  return { zoom: MIN_ZOOM, cx: g.base.x + g.base.w / 2, cy: g.base.y + g.base.h / 2 }
}

export function isFit(state: ViewState): boolean {
  return state.zoom <= MIN_ZOOM + 1e-6
}

export function viewRect(state: ViewState, g: ViewGeometry): Rect {
  const w = g.base.w / state.zoom
  const h = g.base.h / state.zoom
  return { x: state.cx - w / 2, y: state.cy - h / 2, w, h }
}

function clampAxis(center: number, size: number, start: number, length: number): number {
  if (size >= length) return start + length / 2
  return clamp(center, start + size / 2, start + length - size / 2)
}

export function clampState(state: ViewState, g: ViewGeometry): ViewState {
  const zoom = clamp(Number.isFinite(state.zoom) ? state.zoom : MIN_ZOOM, MIN_ZOOM, MAX_ZOOM)
  if (zoom <= MIN_ZOOM + 1e-6) return fitState(g)
  const w = g.base.w / zoom
  const h = g.base.h / zoom
  return {
    zoom,
    cx: clampAxis(state.cx, w, g.bounds.x, g.bounds.w),
    cy: clampAxis(state.cy, h, g.bounds.y, g.bounds.h),
  }
}

// Zooms by factor and keeps the point under (fx, fy) fixed. fx and fy are the
// pointer's position in the viewport as fractions from 0 to 1.
export function zoomAround(state: ViewState, g: ViewGeometry, factor: number, fx: number, fy: number): ViewState {
  const before = viewRect(state, g)
  const px = before.x + fx * before.w
  const py = before.y + fy * before.h
  const zoom = clamp(state.zoom * factor, MIN_ZOOM, MAX_ZOOM)
  const w = g.base.w / zoom
  const h = g.base.h / zoom
  return clampState({ zoom, cx: px - fx * w + w / 2, cy: py - fy * h + h / 2 }, g)
}

export function panState(state: ViewState, g: ViewGeometry, dx: number, dy: number): ViewState {
  return clampState({ ...state, cx: state.cx + dx, cy: state.cy + dy }, g)
}

// The view in which rect fills the window with a margin on every side.
export function stateForRect(rect: Rect, g: ViewGeometry, margin = AREA_MARGIN): ViewState {
  const zoom = Math.min(g.base.w / (rect.w + 2 * margin), g.base.h / (rect.h + 2 * margin))
  return clampState({ zoom, cx: rect.x + rect.w / 2, cy: rect.y + rect.h / 2 }, g)
}

function smoothstep(t: number): number {
  const x = clamp(t, 0, 1)
  return x * x * (3 - 2 * x)
}

// Zoom moves geometrically so each frame looks like the same speed; the center moves in a line.
export function lerpState(from: ViewState, to: ViewState, t: number): ViewState {
  const e = smoothstep(t)
  return {
    zoom: from.zoom * (to.zoom / from.zoom) ** e,
    cx: from.cx + (to.cx - from.cx) * e,
    cy: from.cy + (to.cy - from.cy) * e,
  }
}

// A mouse wheel notch is about 100 pixels; a trackpad pinch arrives as small
// wheel events with ctrlKey set, so it needs a larger gain.
export function wheelFactor(deltaY: number, deltaMode: number, ctrlKey: boolean): number {
  const pixels = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY
  const gain = ctrlKey ? 0.01 : 0.0015
  return Math.exp(-clamp(pixels, -240, 240) * gain)
}

// What a key does to the view, or null when the key is not ours.
export type ZoomKeyAction =
  | { type: "zoom"; factor: number }
  | { type: "fit" }
  | { type: "pan"; dx: number; dy: number }

export function mapZoomKey(input: {
  key: string
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
}): ZoomKeyAction | null {
  if (input.metaKey || input.ctrlKey || input.altKey) return null
  switch (input.key) {
    case "+":
    case "=":
    case "NumpadAdd":
      return { type: "zoom", factor: ZOOM_STEP }
    case "-":
    case "_":
    case "NumpadSubtract":
      return { type: "zoom", factor: 1 / ZOOM_STEP }
    case "0":
      return { type: "fit" }
    case "ArrowLeft":
      return { type: "pan", dx: -PAN_STEP, dy: 0 }
    case "ArrowRight":
      return { type: "pan", dx: PAN_STEP, dy: 0 }
    case "ArrowUp":
      return { type: "pan", dx: 0, dy: -PAN_STEP }
    case "ArrowDown":
      return { type: "pan", dx: 0, dy: PAN_STEP }
    default:
      return null
  }
}

// The layout signature changes when desks are added or removed, or the room
// switches between the wide and the phone layout. A remembered view is only
// valid for the signature it was saved with.
export function layoutSignature(width: number, height: number, seatIds: readonly string[]): string {
  return `${width}x${Math.round(height)}:${[...seatIds].sort().join(",")}`
}

const STORAGE_KEY = "faztudo.office.view"

export interface RememberedView {
  sig: string
  state: ViewState
}

export function loadView(storage: Pick<Storage, "getItem"> | null, sig: string): ViewState | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (!raw) return null
    const data = JSON.parse(raw) as Partial<RememberedView> | null
    const state = data?.state
    if (!data || data.sig !== sig || !state) return null
    if (![state.zoom, state.cx, state.cy].every((n) => typeof n === "number" && Number.isFinite(n))) return null
    return { zoom: state.zoom, cx: state.cx, cy: state.cy }
  } catch {
    return null
  }
}

export function saveView(storage: Pick<Storage, "setItem"> | null, sig: string, state: ViewState): void {
  if (!storage) return
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({ sig, state } satisfies RememberedView))
  } catch {
    // Private mode or a full quota: the view just is not remembered.
  }
}

export function sessionStore(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage
  } catch {
    return null
  }
}

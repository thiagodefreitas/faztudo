import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { Rect } from "./layout"
import {
  ANIMATION_MS,
  clampState,
  fitState,
  isFit,
  lerpState,
  loadView,
  mapZoomKey,
  MAX_ZOOM,
  panState,
  saveView,
  sessionStore,
  stateForRect,
  type ViewGeometry,
  type ViewState,
  viewRect,
  wheelFactor,
  zoomAround,
} from "./zoom"

export interface RoomView {
  state: ViewState
  rect: Rect
  // True when the window is not the fit-all view, or is moving toward it.
  active: boolean
  zoomed: boolean
  canZoomIn: boolean
  canZoomOut: boolean
  fit: () => void
  zoomBy: (factor: number, fx?: number, fy?: number) => void
  focusRect: (rect: Rect) => void
  // Immediate, unanimated change used by gestures. Calls compose in order.
  adjust: (change: (state: ViewState, geometry: ViewGeometry) => ViewState) => void
  geometry: ViewGeometry
}

// Holds the 2D room's view: where the window is, the 300 ms move to a new one,
// and the per-session memory. The remembered view only applies to the layout it
// was saved for; a different signature starts at fit-all.
export function useRoomView({
  geometry,
  sig,
  reducedMotion,
}: {
  geometry: ViewGeometry
  sig: string
  reducedMotion: boolean
}): RoomView {
  const [remembered, setRemembered] = useState<{ sig: string; state: ViewState } | null>(() => {
    const state = loadView(sessionStore(), sig)
    return state ? { sig, state } : null
  })
  const [frame, setFrame] = useState<ViewState | null>(null)
  const raf = useRef<number | null>(null)

  const committed = useMemo(
    () => (remembered && remembered.sig === sig ? clampState(remembered.state, geometry) : fitState(geometry)),
    [remembered, sig, geometry],
  )
  const state = frame ?? committed

  const latest = useRef({ state, geometry, sig, reducedMotion })
  useEffect(() => {
    latest.current = { state, geometry, sig, reducedMotion }
  })
  useEffect(
    () => () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current)
    },
    [],
  )

  const move = useCallback((next: ViewState, animate: boolean) => {
    const { geometry: g, sig: key, state: from, reducedMotion: still } = latest.current
    const target = clampState(next, g)
    if (raf.current !== null) cancelAnimationFrame(raf.current)
    raf.current = null
    saveView(sessionStore(), key, target)
    setRemembered({ sig: key, state: target })
    latest.current = { ...latest.current, state: target }
    if (!animate || still || typeof requestAnimationFrame !== "function") {
      setFrame(null)
      return
    }
    const start = performance.now()
    setFrame(from)
    const step = (now: number) => {
      const t = (now - start) / ANIMATION_MS
      if (t >= 1) {
        raf.current = null
        setFrame(null)
        return
      }
      setFrame(lerpState(from, target, t))
      raf.current = requestAnimationFrame(step)
    }
    raf.current = requestAnimationFrame(step)
  }, [])

  const fit = useCallback(() => move(fitState(latest.current.geometry), true), [move])
  const zoomBy = useCallback(
    (factor: number, fx = 0.5, fy = 0.5) => {
      const { state: s, geometry: g } = latest.current
      move(zoomAround(s, g, factor, fx, fy), true)
    },
    [move],
  )
  const focusRect = useCallback(
    (rect: Rect) => move(stateForRect(rect, latest.current.geometry), true),
    [move],
  )
  const adjust = useCallback(
    (change: (s: ViewState, g: ViewGeometry) => ViewState) => {
      const { state: s, geometry: g } = latest.current
      move(change(s, g), false)
    },
    [move],
  )

  return {
    state,
    rect: viewRect(state, geometry),
    active: !isFit(state) || frame !== null,
    zoomed: !isFit(state),
    canZoomIn: state.zoom < MAX_ZOOM - 1e-6,
    canZoomOut: !isFit(state),
    fit,
    zoomBy,
    focusRect,
    adjust,
    geometry,
  }
}

const DRAG_THRESHOLD_PX = 4
const INTERACTIVE = "button, a, select, input, textarea, [role=button]"

interface Point {
  x: number
  y: number
}

// Mouse wheel and trackpad pinch zoom around the pointer, a drag pans, and two
// fingers pinch and drag. A drag that moved never turns into a click on the
// desk or area underneath.
export function useRoomGestures(ref: RefObject<HTMLElement | null>, view: RoomView, compact: boolean, mounted: boolean) {
  const viewRef = useRef({ view, compact })
  useEffect(() => {
    viewRef.current = { view, compact }
  })

  useEffect(() => {
    const el = ref.current
    if (!el || !mounted) return
    const pointers = new Map<number, Point>()
    let origin: Point | null = null
    let dragging = false
    let suppressClick = false

    const fractions = (clientX: number, clientY: number) => {
      const box = el.getBoundingClientRect()
      return {
        fx: box.width > 0 ? Math.min(1, Math.max(0, (clientX - box.left) / box.width)) : 0.5,
        fy: box.height > 0 ? Math.min(1, Math.max(0, (clientY - box.top) / box.height)) : 0.5,
        box,
      }
    }

    const onWheel = (event: WheelEvent) => {
      const { view: v, compact: phone } = viewRef.current
      // On a phone the room scrolls until the person zooms in; only a pinch zooms it from fit-all.
      if (phone && !v.zoomed && !event.ctrlKey) return
      event.preventDefault()
      const { fx, fy } = fractions(event.clientX, event.clientY)
      const factor = wheelFactor(event.deltaY, event.deltaMode, event.ctrlKey)
      v.adjust((s, g) => zoomAround(s, g, factor, fx, fy))
    }

    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType === "mouse" && event.button !== 0) return
      if (event.target instanceof Element && event.target.closest(INTERACTIVE)) return
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
      if (pointers.size === 1) {
        origin = { x: event.clientX, y: event.clientY }
        dragging = false
      }
    }

    const onPointerMove = (event: PointerEvent) => {
      const point = pointers.get(event.pointerId)
      if (!point) return
      const { view: v } = viewRef.current
      const before = [...pointers.values()].map((p) => ({ ...p }))
      point.x = event.clientX
      point.y = event.clientY
      const box = el.getBoundingClientRect()
      if (box.width <= 0 || box.height <= 0) return

      if (pointers.size >= 2) {
        const [a0, b0] = before
        const [a1, b1] = [...pointers.values()]
        if (!a0 || !b0 || !a1 || !b1) return
        const d0 = Math.hypot(a0.x - b0.x, a0.y - b0.y)
        const d1 = Math.hypot(a1.x - b1.x, a1.y - b1.y)
        const m0 = { x: (a0.x + b0.x) / 2, y: (a0.y + b0.y) / 2 }
        const m1 = { x: (a1.x + b1.x) / 2, y: (a1.y + b1.y) / 2 }
        dragging = true
        const { fx, fy } = fractions(m1.x, m1.y)
        if (d0 > 0 && d1 > 0) v.adjust((s, g) => zoomAround(s, g, d1 / d0, fx, fy))
        const r = viewRef.current.view.rect
        v.adjust((s, g) => panState(s, g, (-(m1.x - m0.x) / box.width) * r.w, (-(m1.y - m0.y) / box.height) * r.h))
        return
      }

      if (!v.zoomed || !origin) return
      if (!dragging) {
        if (Math.hypot(event.clientX - origin.x, event.clientY - origin.y) < DRAG_THRESHOLD_PX) return
        dragging = true
        try {
          el.setPointerCapture(event.pointerId)
        } catch {
          // The pointer may already be gone; the drag still works from move events.
        }
      }
      const prev = before[0]
      if (!prev) return
      const r = v.rect
      v.adjust((s, g) =>
        panState(s, g, (-(event.clientX - prev.x) / box.width) * r.w, (-(event.clientY - prev.y) / box.height) * r.h),
      )
    }

    const onPointerEnd = (event: PointerEvent) => {
      if (!pointers.delete(event.pointerId)) return
      if (pointers.size === 0) {
        if (dragging) {
          suppressClick = true
          setTimeout(() => {
            suppressClick = false
          }, 0)
        }
        dragging = false
        origin = null
      }
    }

    const onClickCapture = (event: MouseEvent) => {
      if (!suppressClick) return
      suppressClick = false
      event.stopPropagation()
      event.preventDefault()
    }

    // Without this the browser scrolls or page-zooms instead of letting the gesture through.
    const onTouchMove = (event: TouchEvent) => {
      if (event.touches.length >= 2 || viewRef.current.view.zoomed) event.preventDefault()
    }

    el.addEventListener("wheel", onWheel, { passive: false })
    el.addEventListener("pointerdown", onPointerDown)
    el.addEventListener("pointermove", onPointerMove)
    el.addEventListener("pointerup", onPointerEnd)
    el.addEventListener("pointercancel", onPointerEnd)
    el.addEventListener("click", onClickCapture, true)
    el.addEventListener("touchmove", onTouchMove, { passive: false })
    return () => {
      el.removeEventListener("wheel", onWheel)
      el.removeEventListener("pointerdown", onPointerDown)
      el.removeEventListener("pointermove", onPointerMove)
      el.removeEventListener("pointerup", onPointerEnd)
      el.removeEventListener("pointercancel", onPointerEnd)
      el.removeEventListener("click", onClickCapture, true)
      el.removeEventListener("touchmove", onTouchMove)
    }
  }, [ref, mounted])
}

// Plus and minus zoom, 0 fits all, arrows pan once zoomed. Returns true when the key was ours.
export function handleRoomKey(view: RoomView, event: { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean }): boolean {
  const action = mapZoomKey(event)
  if (!action) return false
  if (action.type === "fit") {
    view.fit()
    return true
  }
  if (action.type === "zoom") {
    view.zoomBy(action.factor)
    return true
  }
  // At fit-all the arrows belong to the browser, so a phone's room still scrolls.
  if (!view.zoomed) return false
  view.adjust((s, g) => panState(s, g, action.dx * view.rect.w, action.dy * view.rect.h))
  return true
}

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react"
import { cx } from "../../lib/cx"
import type { RoomArea } from "./layout"

const ITEM =
  "inline-flex min-h-8 items-center justify-center px-2.5 text-[12px] font-medium text-ink transition-colors duration-150 hover:bg-sidebar focus-visible:z-10 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent disabled:opacity-40 disabled:hover:bg-transparent motion-reduce:transition-none"

// Zoom buttons, Fit all, and a searchable jump list, drawn as one compact group.
// The 2D room uses the zoom buttons. The 3D room omits them because its keys and wheel already zoom.
export function ZoomControls({
  areas,
  onFit,
  onJump,
  onZoomIn,
  onZoomOut,
  canZoomIn = true,
  canZoomOut = true,
  className,
}: {
  areas: readonly RoomArea[]
  onFit: () => void
  onJump: (area: RoomArea) => void
  onZoomIn?: () => void
  onZoomOut?: () => void
  canZoomIn?: boolean
  canZoomOut?: boolean
  className?: string
}) {
  return (
    <div
      role="group"
      aria-label="Zoom"
      data-testid="office-zoom-controls"
      className={cx(
        "absolute bottom-2 right-2 z-10 inline-flex max-w-[calc(100%-1rem)] items-stretch overflow-visible rounded-lg border border-line bg-surface shadow-xs",
        className,
      )}
    >
      {onZoomOut && (
        <button type="button" aria-label="Zoom out" disabled={!canZoomOut} onClick={onZoomOut} className={cx(ITEM, "border-r border-line")}>
          -
        </button>
      )}
      {onZoomIn && (
        <button type="button" aria-label="Zoom in" disabled={!canZoomIn} onClick={onZoomIn} className={cx(ITEM, "border-r border-line")}>
          +
        </button>
      )}
      <button type="button" onClick={onFit} className={cx(ITEM, areas.length > 0 && "border-r border-line")}>
        Fit all
      </button>
      {areas.length > 0 && <JumpToArea areas={areas} onJump={onJump} />}
    </div>
  )
}

function JumpToArea({ areas, onJump }: { areas: readonly RoomArea[]; onJump: (area: RoomArea) => void }) {
  const listId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [active, setActive] = useState(0)
  const [box, setBox] = useState<{ left: number; bottom: number; width: number } | null>(null)
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return [...areas]
    return areas.filter((area) => area.label.toLowerCase().includes(needle))
  }, [areas, query])

  useEffect(() => {
    if (!open) return
    function onPointer(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener("pointerdown", onPointer)
    return () => document.removeEventListener("pointerdown", onPointer)
  }, [open])

  function choose(area: RoomArea) {
    onJump(area)
    setQuery("")
    setOpen(false)
  }

  // The floor card clips overflow, so the list is fixed to the viewport above the field.
  function placeList() {
    const rect = rootRef.current?.getBoundingClientRect()
    if (!rect) return
    setBox({
      left: rect.left,
      bottom: window.innerHeight - rect.top + 4,
      width: Math.max(rect.width, 144),
    })
  }

  useEffect(() => {
    if (!open) return
    function place() {
      placeList()
    }
    window.addEventListener("resize", place)
    window.addEventListener("scroll", place, true)
    return () => {
      window.removeEventListener("resize", place)
      window.removeEventListener("scroll", place, true)
    }
  }, [open])

  const activeIndex = matches.length === 0 ? 0 : Math.min(active, matches.length - 1)

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault()
      placeList()
      setOpen(true)
      setActive((index) => Math.min(matches.length - 1, index + (open ? 1 : 0)))
      return
    }
    if (event.key === "ArrowUp") {
      event.preventDefault()
      placeList()
      setOpen(true)
      setActive((index) => Math.max(0, index - 1))
      return
    }
    if (event.key === "Escape") {
      event.preventDefault()
      setOpen(false)
      setQuery("")
      return
    }
    if (event.key === "Enter") {
      event.preventDefault()
      const area = matches[activeIndex] ?? matches[0]
      if (area) choose(area)
    }
  }

  const activeId = matches[activeIndex] ? `${listId}-${matches[activeIndex].id}` : undefined

  return (
    <div ref={rootRef} className="relative">
      <input
        role="combobox"
        aria-label="Jump to area"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open ? activeId : undefined}
        placeholder="Jump to..."
        value={query}
        onChange={(event) => {
          setQuery(event.target.value)
          setActive(0)
          placeList()
          setOpen(true)
        }}
        onFocus={() => {
          setActive(0)
          placeList()
          setOpen(true)
        }}
        onKeyDown={onKeyDown}
        className="h-8 w-28 bg-transparent px-2 text-[12px] text-ink outline-none placeholder:text-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent sm:w-32"
      />
      {open && box && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Areas"
          style={{ position: "fixed", left: box.left, bottom: box.bottom, width: box.width, zIndex: 40 }}
          className="max-h-48 overflow-auto rounded-lg border border-line bg-surface py-1 shadow-xs"
        >
          {matches.length === 0 ? (
            <li className="px-2 py-1 text-[12px] text-muted">No matches</li>
          ) : (
            matches.map((area, index) => (
              <li key={area.id} role="presentation">
                <button
                  type="button"
                  id={`${listId}-${area.id}`}
                  role="option"
                  aria-selected={index === activeIndex}
                  onMouseDown={(event) => {
                    event.preventDefault()
                    choose(area)
                  }}
                  onMouseEnter={() => setActive(index)}
                  className={cx(
                    "block w-full px-2 py-1 text-left text-[12px] text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent",
                    index === activeIndex ? "bg-sidebar" : "hover:bg-sidebar",
                  )}
                >
                  {area.label}
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  )
}

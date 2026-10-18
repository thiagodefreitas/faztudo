import { cx } from "../../lib/cx"
import type { RoomArea } from "./layout"

const BUTTON =
  "inline-flex min-h-8 min-w-8 items-center justify-center rounded-md border border-line bg-surface px-2 text-[12px] font-medium text-ink hover:bg-sidebar disabled:opacity-40 disabled:hover:bg-surface"

// Zoom buttons, "Fit all" and the list of areas to jump to. The 2D room uses
// all of it; the 3D room has no zoom buttons because its own keys and wheel
// already zoom.
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
        "absolute bottom-2 right-2 z-10 flex max-w-[calc(100%-1rem)] items-center gap-1 rounded-lg border border-line bg-surface/90 p-1 shadow-xs",
        className,
      )}
    >
      {onZoomOut && (
        <button type="button" aria-label="Zoom out" disabled={!canZoomOut} onClick={onZoomOut} className={BUTTON}>
          -
        </button>
      )}
      {onZoomIn && (
        <button type="button" aria-label="Zoom in" disabled={!canZoomIn} onClick={onZoomIn} className={BUTTON}>
          +
        </button>
      )}
      <button type="button" onClick={onFit} className={BUTTON}>
        Fit all
      </button>
      {areas.length > 0 && (
        <select
          aria-label="Jump to area"
          value=""
          onChange={(event) => {
            const area = areas.find((item) => item.id === event.target.value)
            if (area) onJump(area)
          }}
          className="min-h-8 min-w-0 max-w-32 rounded-md border border-line bg-surface px-1.5 text-[12px] text-ink"
        >
          <option value="">Jump to...</option>
          {areas.map((area) => (
            <option key={area.id} value={area.id}>
              {area.label}
            </option>
          ))}
        </select>
      )}
    </div>
  )
}

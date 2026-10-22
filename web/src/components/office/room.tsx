import type { LaneMeterBar, TaskBoardNote } from "./avatar"
import type { PlacedLaneStrip, PlacedTaskBoard, PlacedZone, Rect } from "./layout"
import { layoutWallFixtures, ROOM_W, WALL_H } from "./layout"

const SANS = "Inter, ui-sans-serif, system-ui, sans-serif"
const ZONE_TINTS = [
  "var(--color-accent-soft)",
  "var(--color-agent-2-soft)",
  "var(--color-agent-5-soft)",
  "var(--color-agent-4-soft)",
  "var(--color-agent-1-soft)",
  "var(--color-ok-soft)",
]

// The room around the desks: floor, wall, task board, lane meter strip, rug
// and a few plants. Everything uses the brand CSS variables, so light and dark
// both work.

function clipText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 2)}..` : text
}

function Plant({ x, y, size = 1 }: { x: number; y: number; size?: number }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${size})`} aria-hidden="true">
      <ellipse cx="0" cy="2" rx="14" ry="4" fill="var(--color-ink)" fillOpacity="0.08" />
      <path d="M-9 -12H9L6 2H-6Z" fill="var(--color-agent-2-soft)" stroke="var(--color-agent-2)" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M0 -12C-12 -18 -14 -30 -8 -36C-4 -28 0 -22 0 -12Z" fill="var(--color-ok)" fillOpacity="0.8" />
      <path d="M0 -12C12 -18 14 -30 8 -36C4 -28 0 -22 0 -12Z" fill="var(--color-ok)" fillOpacity="0.65" />
      <path d="M0 -12C-3 -24 0 -34 0 -42C4 -34 4 -22 0 -12Z" fill="var(--color-ok)" />
    </g>
  )
}

function Window({ x }: { x: number }) {
  return (
    <g aria-hidden="true">
      <rect x={x} y="14" width="86" height="30" rx="4" fill="var(--color-accent-soft)" stroke="var(--color-line)" />
      <path d={`M${x + 43} 14V44`} stroke="var(--color-line)" />
    </g>
  )
}

function Shelf({ x }: { x: number }) {
  const books = ["var(--color-agent-1)", "var(--color-agent-4)", "var(--color-agent-3)", "var(--color-agent-2)", "var(--color-agent-5)"]
  return (
    <g aria-hidden="true">
      <rect x={x} y="40" width="84" height="5" rx="2" fill="var(--color-line)" />
      {books.map((fill, i) => (
        <rect key={fill} x={x + 6 + i * 12} y={i % 2 === 0 ? 20 : 25} width="9" height={i % 2 === 0 ? 20 : 15} rx="1.5" fill={fill} fillOpacity="0.75" />
      ))}
    </g>
  )
}

function WallTaskBoard({ board }: { board: PlacedTaskBoard }) {
  return (
    <g data-testid="office-task-board" aria-label="Task board">
      <rect
        x={board.x}
        y={board.y}
        width={board.w}
        height={board.h}
        rx="6"
        fill="var(--color-surface)"
        stroke="var(--color-line)"
      />
      <text
        x={board.x + 10}
        y={board.y + 28}
        fontSize="12"
        fontFamily={SANS}
        fontWeight="600"
        fill="var(--color-faint)"
      >
        Tasks
      </text>
      {board.notes.map(({ note, x, y, w, h }) => (
        <g
          key={note.id}
          data-testid={`task-note-${note.id}`}
          data-hue={note.hue}
        >
          <title>{`@${note.handle}: ${note.title}`}</title>
          <rect
            x={x}
            y={y}
            width={w}
            height={h}
            rx="3.5"
            fill={note.bg}
            stroke={note.accent}
            strokeWidth="1"
          />
          <rect x={x} y={y} width={w} height="5" rx="2" fill={note.accent} />
          <text
            x={x + 6}
            y={y + 16}
            fontSize="12"
            fontFamily={SANS}
            fontWeight="600"
            fill="var(--color-ink)"
          >
            {clipText(`@${note.handle}`, 14)}
          </text>
          <text x={x + 6} y={y + 30} fontSize="11" fontFamily={SANS} fill="var(--color-muted)">
            {clipText(note.title, 16)}
          </text>
        </g>
      ))}
    </g>
  )
}

function WallLaneStrip({ strip }: { strip: PlacedLaneStrip }) {
  return (
    <g data-testid="office-lane-strip" aria-label="Lane meter strip">
      <rect
        x={strip.x}
        y={strip.y}
        width={strip.w}
        height={strip.h}
        rx="6"
        fill="var(--color-surface)"
        stroke="var(--color-line)"
      />
      <text
        x={strip.x + 10}
        y={strip.y + 28}
        fontSize="12"
        fontFamily={SANS}
        fontWeight="600"
        fill="var(--color-faint)"
      >
        Lanes
      </text>
      {strip.bars.map(({ bar, x, y, w, h, fillH }) => {
        const shortLabel = bar.id.split("/")[0] ?? bar.id
        const meterW = Math.max(8, w - 12)
        const meterH = 4
        const filled = Math.max(3, Math.min(meterW, Math.round(meterW * (fillH / Math.max(h, 1)))))
        return (
          <g
            key={bar.id}
            data-testid={`lane-bar-${bar.id}`}
            data-health={bar.health}
          >
            <title>{`${bar.id} (${bar.health})`}</title>
            <circle cx={x + 8} cy={y + 10} r="3.5" fill={bar.color} />
            <text x={x + 16} y={y + 14} fontSize="12" fontFamily={SANS} fill="var(--color-ink)">
              {clipText(shortLabel, 8)}
            </text>
            <rect x={x + 6} y={y + h - 8} width={meterW} height={meterH} rx="2" fill="var(--color-sidebar)" />
            <rect x={x + 6} y={y + h - 8} width={filled} height={meterH} rx="2" fill={bar.color} />
          </g>
        )
      })}
    </g>
  )
}

const AREA_CLICK_STYLE = { cursor: "zoom-in" } as const

// Keyboard and screen reader targets for the area names. They are drawn after
// the desks so the desks stay first in the tab order, and sit over the names
// the backdrop already paints. Enter or Space zooms to the area.
export function AreaLabelTargets({
  zones,
  rug,
  onSelect,
}: {
  zones: readonly PlacedZone[]
  rug: Rect | null
  onSelect: (area: Rect) => void
}) {
  const targets: { key: string; label: string; box: Rect; area: Rect }[] = zones.map((zone) => ({
    key: zone.id,
    label: zone.label,
    area: zone,
    box: { x: zone.x + 12, y: zone.y + 5, w: Math.min(zone.w - 24, zone.label.length * 9 + 16), h: 22 },
  }))
  if (rug) targets.push({ key: "director", label: "Director", area: rug, box: { x: rug.x + 14, y: rug.y + 6, w: 84, h: 20 } })
  return (
    <g>
      {targets.map(({ key, label, box, area }) => (
        <rect
          key={key}
          data-testid={`area-label-${key}`}
          role="button"
          tabIndex={0}
          aria-label={`Zoom to ${label}`}
          x={box.x}
          y={box.y}
          width={Math.max(box.w, 24)}
          height={box.h}
          rx="6"
          fill="transparent"
          stroke="transparent"
          strokeWidth="1.5"
          style={AREA_CLICK_STYLE}
          className="outline-none focus-visible:stroke-accent"
          onClick={() => onSelect(area)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return
            event.preventDefault()
            onSelect(area)
          }}
        />
      ))}
    </g>
  )
}

export function RoomBackdrop({
  width = ROOM_W,
  height,
  zones,
  rug,
  taskNotes = [],
  laneBars = [],
  onAreaClick,
}: {
  width?: number
  height: number
  zones: PlacedZone[]
  rug: Rect | null
  taskNotes?: readonly TaskBoardNote[]
  laneBars?: readonly LaneMeterBar[]
  // Clicking bare floor of a zone, a pod or the Director rug zooms to it.
  onAreaClick?: (area: Rect) => void
}) {
  const areaProps = (area: Rect) =>
    onAreaClick ? { onClick: () => onAreaClick(area), style: AREA_CLICK_STYLE } : {}
  const compact = width < 640
  const fixtures = layoutWallFixtures(width, taskNotes, laneBars)
  return (
    <g>
      <defs>
        <pattern id="office-grid" width="48" height="48" patternUnits="userSpaceOnUse">
          <path d="M48 0H0V48" fill="none" stroke="var(--color-line)" strokeWidth="1" strokeOpacity="0.22" />
        </pattern>
      </defs>
      <rect width={width} height={height} fill="var(--color-canvas)" />
      <rect width={width} height={height} fill="url(#office-grid)" />

      <rect width={width} height={WALL_H} fill="var(--color-sidebar)" />
      <rect y={WALL_H - 3} width={width} height="3" fill="var(--color-line)" />
      {fixtures.windows.map((x) => (
        <Window key={x} x={x} />
      ))}
      {fixtures.shelves.map((x) => (
        <Shelf key={x} x={x} />
      ))}
      {fixtures.taskBoard && <WallTaskBoard board={fixtures.taskBoard} />}
      {fixtures.laneStrip && <WallLaneStrip strip={fixtures.laneStrip} />}
      <Plant x={compact ? 26 : 36} y={WALL_H - 6} size={1.1} />

      {zones.map((zone, index) => (
        <g key={zone.id} data-testid={`zone-${zone.id}`}>
          <rect
            x={zone.x}
            y={zone.y}
            width={zone.w}
            height={zone.h}
            rx="16"
            fill={ZONE_TINTS[index % ZONE_TINTS.length]}
            fillOpacity="0.85"
            stroke="var(--color-line)"
            {...areaProps(zone)}
          />
          <text x={zone.x + 14} y={zone.y + 16} fontSize="13" fontFamily={SANS} fontWeight="600" fill="var(--color-muted)">
            {zone.label}
          </text>
          {zone.pods.map((pod) => (
            <g key={`${pod.x}-${pod.y}`} aria-hidden="true">
              <rect
                x={pod.x}
                y={pod.y}
                width={pod.w}
                height={pod.h}
                rx="12"
                fill="var(--color-surface)"
                fillOpacity="0.92"
                stroke="var(--color-line)"
                {...areaProps(pod)}
              />
            </g>
          ))}
        </g>
      ))}

      {rug && (
        <g aria-hidden="true">
          <rect x={rug.x} y={rug.y} width={rug.w} height={rug.h} rx="18" fill="var(--color-accent-soft)" stroke="var(--color-accent)" strokeOpacity="0.55" {...areaProps(rug)} />
          <text x={rug.x + 16} y={rug.y + 16} fontSize="13" fontFamily={SANS} fontWeight="600" fill="var(--color-accent)">
            Director
          </text>
        </g>
      )}

      <Plant x={width - (compact ? 26 : 40)} y={height - 22} size={1.2} />
      <Plant x={compact ? 26 : 40} y={height - 22} size={1.2} />
    </g>
  )
}

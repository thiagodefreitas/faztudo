import type { PlacedZone, Rect } from "./layout"
import { ROOM_W, WALL_H } from "./layout"

// The room around the desks: floor, wall, rug and a few plants. Everything
// uses the brand CSS variables, so light and dark both work.

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

export function RoomBackdrop({
  width = ROOM_W,
  height,
  zones,
  rug,
}: {
  width?: number
  height: number
  zones: PlacedZone[]
  rug: Rect | null
}) {
  const compact = width < 640
  const windows = compact ? [64, 240] : [70, 230, 390, 740, 900]
  const shelves = compact ? [154] : [560, 1060]
  return (
    <g>
      <defs>
        <pattern id="office-grid" width="40" height="40" patternUnits="userSpaceOnUse">
          <path d="M40 0H0V40" fill="none" stroke="var(--color-line)" strokeWidth="1" strokeOpacity="0.45" />
        </pattern>
      </defs>
      <rect width={width} height={height} fill="var(--color-canvas)" />
      <rect width={width} height={height} fill="url(#office-grid)" />

      <rect width={width} height={WALL_H} fill="var(--color-sidebar)" />
      <rect y={WALL_H - 3} width={width} height="3" fill="var(--color-line)" />
      {windows.map((x) => (
        <Window key={x} x={x} />
      ))}
      {shelves.map((x) => (
        <Shelf key={x} x={x} />
      ))}
      <Plant x={compact ? 26 : 36} y={WALL_H - 6} size={1.1} />

      {zones.map((zone) => (
        <g key={zone.id} data-testid={`zone-${zone.id}`}>
          <rect
            x={zone.x}
            y={zone.y}
            width={zone.w}
            height={zone.h}
            rx="18"
            fill="var(--color-surface)"
            fillOpacity="0.55"
            stroke="var(--color-line)"
            strokeDasharray="5 5"
          />
          <text x={zone.x + 20} y={zone.y + 21} fontSize="11" fontWeight="600" letterSpacing="1.2" fill="var(--color-faint)">
            {zone.label}
          </text>
          {zone.pods.map((pod) => (
            <g key={`${pod.x}-${pod.y}`} aria-hidden="true">
              <rect x={pod.x} y={pod.y} width={pod.w} height={pod.h} rx="14" fill="var(--color-sidebar)" fillOpacity="0.7" />
              <circle cx={pod.x + pod.w / 2} cy={pod.y + pod.h / 2} r="7" fill="var(--color-accent-soft)" stroke="var(--color-accent)" strokeOpacity="0.5" />
            </g>
          ))}
        </g>
      ))}

      {rug && (
        <g aria-hidden="true">
          <rect x={rug.x} y={rug.y} width={rug.w} height={rug.h} rx="22" fill="var(--color-accent-soft)" stroke="var(--color-accent)" strokeOpacity="0.45" />
          <rect x={rug.x + 8} y={rug.y + 8} width={rug.w - 16} height={rug.h - 16} rx="16" fill="none" stroke="var(--color-accent)" strokeOpacity="0.3" strokeDasharray="3 5" />
          <text x={rug.x + 22} y={rug.y + 20} fontSize="10" fontWeight="600" letterSpacing="1.2" fill="var(--color-accent)">
            Director
          </text>
        </g>
      )}

      <Plant x={width - (compact ? 26 : 40)} y={height - 22} size={1.2} />
      <Plant x={compact ? 26 : 40} y={height - 22} size={1.2} />
    </g>
  )
}

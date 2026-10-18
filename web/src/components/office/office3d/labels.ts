export interface NameLabelBox {
  id: string
  x: number
  y: number
  halfW: number
  halfH: number
  depth: number
}

export interface NameLabelPlacement {
  id: string
  offsetX: number
  offsetY: number
  opacity: number
}

// Try these screen-space shifts before fading a label that sits behind another.
const Y_SHIFTS = [0, -22, 22, -44, 44, -66, 66]

// Floor labels sit above the desk top and monitor so furniture cannot cover them.
export const FLOOR_LABEL_CLEAR_Y = 1.2

export interface FloorRect {
  x: number
  z: number
  w: number
  d: number
}

function overlaps(
  ax: number,
  ay: number,
  aw: number,
  ah: number,
  bx: number,
  by: number,
  bw: number,
  bh: number,
): boolean {
  return Math.abs(ax - bx) < aw + bw && Math.abs(ay - by) < ah + bh
}

// Closer labels stay put. Labels behind them shift up or down, then fade if every shift still collides.
export function layoutNameLabels(labels: readonly NameLabelBox[]): NameLabelPlacement[] {
  const order = labels.map((label) => label)
  order.sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id))

  const placed: {
    id: string
    x: number
    y: number
    halfW: number
    halfH: number
    offsetX: number
    offsetY: number
    opacity: number
  }[] = []
  const byId = new Map<string, NameLabelPlacement>()

  for (const label of order) {
    let chosen: { offsetX: number; offsetY: number } | null = null
    for (const shift of Y_SHIFTS) {
      const y = label.y + shift
      const hit = placed.some(
        (other) =>
          other.opacity > 0.5 &&
          overlaps(label.x, y, label.halfW, label.halfH, other.x, other.y, other.halfW, other.halfH),
      )
      if (!hit) {
        chosen = { offsetX: 0, offsetY: shift }
        break
      }
    }
    if (chosen) {
      placed.push({
        id: label.id,
        x: label.x,
        y: label.y + chosen.offsetY,
        halfW: label.halfW,
        halfH: label.halfH,
        offsetX: chosen.offsetX,
        offsetY: chosen.offsetY,
        opacity: 1,
      })
      byId.set(label.id, { id: label.id, ...chosen, opacity: 1 })
    } else {
      placed.push({
        id: label.id,
        x: label.x,
        y: label.y,
        halfW: label.halfW,
        halfH: label.halfH,
        offsetX: 0,
        offsetY: 0,
        opacity: 0.15,
      })
      byId.set(label.id, { id: label.id, offsetX: 0, offsetY: 0, opacity: 0.15 })
    }
  }

  return labels.map((label) => byId.get(label.id) ?? { id: label.id, offsetX: 0, offsetY: 0, opacity: 1 })
}

// Back edge of a zone, pod, or rug, lifted above desks. The back of the room is -z.
export function floorLabelAnchor(
  rect: FloorRect,
  kind: "zone" | "pod" | "director",
): { x: number; y: number; z: number } {
  const y = kind === "pod" ? 1.32 : 1.56
  const maxInsetX = kind === "pod" ? 0.62 : 0.95
  const insetX = Math.min(Math.max(rect.w * 0.5 - 0.04, 0.2), maxInsetX)
  const maxInsetZ = kind === "pod" ? 0.16 : 0.3
  const insetZ = Math.min(Math.max(rect.d * 0.5 - 0.04, 0.1), maxInsetZ)
  return {
    x: rect.x - rect.w / 2 + insetX,
    y,
    z: rect.z - rect.d / 2 + insetZ,
  }
}

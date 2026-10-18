import { identityOf } from "../../lib/avatar"
import type { DeskInfo } from "./state"

// The room is one SVG. Everything here is in its user units, so the picture
// scales with the viewport and the layout stays plain arithmetic.
export const ROOM_W = 1200
export const WALL_H = 64
export const DESK_W = 120
export const DESK_H = 108
export const DIRECTOR_SCALE = 1.2

const MARGIN = 40
const ZONE_PAD = 20
const ZONE_HEAD = 30
const ZONE_GAP = 24
const POD_PAD = 14
const POD_GAP = 16
const DESK_GAP_X = 14
const DESK_GAP_Y = 10
const POD_COLS = 2
const POD_SIZE = 4
const BOTTOM = 24

export const POD_W = POD_COLS * DESK_W + DESK_GAP_X + 2 * POD_PAD

export interface ZoneSpec {
  id: string
  label: string
  desks: DeskInfo[]
}

// A zone is a named area of the floor made of pods. Personas and raw CLIs are
// the two zones today; a team or a department can become one more ZoneSpec
// without touching the placement code below.
export function zonesOf(desks: DeskInfo[]): ZoneSpec[] {
  const members = desks.filter((desk) => !desk.isDirector)
  const personas = members.filter((desk) => identityOf(desk.member).role !== null)
  const clis = members.filter((desk) => identityOf(desk.member).role === null)
  const zones: ZoneSpec[] = [
    { id: "personas", label: "Personas", desks: personas },
    { id: "agents", label: "Agents", desks: clis },
  ]
  return zones.filter((zone) => zone.desks.length > 0)
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface Seat {
  desk: DeskInfo
  x: number
  y: number
  scale: number
}

export interface PlacedZone extends Rect {
  id: string
  label: string
  pods: Rect[]
}

export interface RoomLayout {
  width: number
  height: number
  zones: PlacedZone[]
  // Reading order: zone by zone, pod by pod, left to right and top to bottom,
  // then the Director at the front of the room.
  seats: Seat[]
  rug: Rect | null
}

function podHeight(count: number): number {
  const rows = Math.ceil(count / POD_COLS)
  return rows * DESK_H + (rows - 1) * DESK_GAP_Y + 2 * POD_PAD
}

interface ZoneBox extends PlacedZone {
  seats: Seat[]
}

// Sizes a zone and places its desks relative to the zone origin (0, 0).
function boxZone(spec: ZoneSpec, maxCols: number): ZoneBox {
  const pods = Math.ceil(spec.desks.length / POD_SIZE)
  const cols = Math.min(pods, maxCols)
  const rows = Math.ceil(pods / cols)
  const rowHeights: number[] = []
  for (let row = 0; row < rows; row += 1) {
    const inRow = Math.min(cols, pods - row * cols)
    let tallest = 0
    for (let col = 0; col < inRow; col += 1) {
      const count = Math.min(POD_SIZE, spec.desks.length - (row * cols + col) * POD_SIZE)
      tallest = Math.max(tallest, podHeight(count))
    }
    rowHeights.push(tallest)
  }
  const width = cols * POD_W + (cols - 1) * POD_GAP + 2 * ZONE_PAD
  const height =
    ZONE_HEAD + rowHeights.reduce((sum, h) => sum + h, 0) + (rows - 1) * POD_GAP + ZONE_PAD
  const placedPods: Rect[] = []
  const seats: Seat[] = []
  let y = ZONE_HEAD
  for (let row = 0; row < rows; row += 1) {
    const inRow = Math.min(cols, pods - row * cols)
    for (let col = 0; col < inRow; col += 1) {
      const index = row * cols + col
      const members = spec.desks.slice(index * POD_SIZE, (index + 1) * POD_SIZE)
      const pod = { x: ZONE_PAD + col * (POD_W + POD_GAP), y, w: POD_W, h: podHeight(members.length) }
      placedPods.push(pod)
      members.forEach((desk, i) => {
        seats.push({
          desk,
          x: pod.x + POD_PAD + (i % POD_COLS) * (DESK_W + DESK_GAP_X),
          y: pod.y + POD_PAD + Math.floor(i / POD_COLS) * (DESK_H + DESK_GAP_Y),
          scale: 1,
        })
      })
    }
    y += (rowHeights[row] ?? 0) + POD_GAP
  }
  return { id: spec.id, label: spec.label, x: 0, y: 0, w: width, h: height, pods: placedPods, seats }
}

export function layoutRoom(desks: DeskInfo[]): RoomLayout {
  const specs = zonesOf(desks)
  const maxCols = specs.length === 1 ? 3 : 2
  const boxes = specs.map((spec) => boxZone(spec, maxCols))

  // Zones sit side by side and wrap to a new row when the room is full.
  const rows: ZoneBox[][] = []
  let rowWidth = 0
  for (const box of boxes) {
    const last = rows.at(-1)
    if (last && rowWidth + ZONE_GAP + box.w <= ROOM_W - 2 * MARGIN) {
      last.push(box)
      rowWidth += ZONE_GAP + box.w
    } else {
      rows.push([box])
      rowWidth = box.w
    }
  }

  const zones: PlacedZone[] = []
  const seats: Seat[] = []
  let y = WALL_H + 20
  for (const row of rows) {
    const total = row.reduce((sum, box) => sum + box.w, 0) + (row.length - 1) * ZONE_GAP
    let x = (ROOM_W - total) / 2
    let tallest = 0
    for (const box of row) {
      zones.push({ id: box.id, label: box.label, x, y, w: box.w, h: box.h, pods: box.pods.map((pod) => ({ ...pod, x: pod.x + x, y: pod.y + y })) })
      for (const seat of box.seats) seats.push({ ...seat, x: seat.x + x, y: seat.y + y })
      x += box.w + ZONE_GAP
      tallest = Math.max(tallest, box.h)
    }
    y += tallest + ZONE_GAP
  }

  const directors = desks.filter((desk) => desk.isDirector)
  let rug: Rect | null = null
  if (directors.length > 0) {
    const w = DESK_W * DIRECTOR_SCALE
    const h = DESK_H * DIRECTOR_SCALE
    const step = Math.min(w + 48, (ROOM_W - 2 * MARGIN - 80) / directors.length)
    const span = step * (directors.length - 1) + w
    const left = (ROOM_W - span) / 2
    rug = { x: left - 40, y, w: span + 80, h: h + 28 }
    directors.forEach((desk, i) => {
      seats.push({ desk, x: left + i * step, y: y + 14, scale: DIRECTOR_SCALE })
    })
    y += rug.h
  }

  return { width: ROOM_W, height: y + BOTTOM, zones, seats, rug }
}

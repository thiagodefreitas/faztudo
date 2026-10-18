import { identityOf } from "../../lib/avatar"
import type { Department } from "../../types"
import type { LaneMeterBar, TaskBoardNote } from "./office3d/poses"
import type { DeskInfo } from "./state"

// The room is one SVG. Everything here is in its user units, so the picture
// scales with the viewport and the layout stays plain arithmetic.
export const ROOM_W = 1200
export const COMPACT_ROOM_W = 390
export const WALL_H = 64
export const DESK_W = 120
export const DESK_H = 108
export const DIRECTOR_SCALE = 1.2

const MARGIN = 40
const COMPACT_MARGIN = 18
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

function sameHandle(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

function departmentHandles(department: Department): string[] {
  const lead = department.lead?.trim()
  const members = department.members.filter((m) => !lead || !sameHandle(m, lead))
  return [...(lead ? [lead] : []), ...members]
}

// A zone is a named area of the floor made of pods. When the org defines
// departments, each department becomes a zone with its name on the floor,
// followed by any unassigned Personas and Agents.
export function zonesOf(desks: DeskInfo[], departments?: readonly Department[]): ZoneSpec[] {
  const members = desks.filter((desk) => !desk.isDirector)
  if (!departments || departments.length === 0) {
    const personas = members.filter((desk) => identityOf(desk.member).role !== null)
    const clis = members.filter((desk) => identityOf(desk.member).role === null)
    const zones: ZoneSpec[] = [
      { id: "personas", label: "Personas", desks: personas },
      { id: "agents", label: "Agents", desks: clis },
    ]
    return zones.filter((zone) => zone.desks.length > 0)
  }

  const assignedIds = new Set<string>()
  const deptZones: ZoneSpec[] = []
  for (const dept of departments) {
    const handles = departmentHandles(dept)
    const deptDesks: DeskInfo[] = []
    for (const handle of handles) {
      const desk = members.find((d) => !assignedIds.has(d.member.id) && sameHandle(d.member.handle, handle))
      if (desk) {
        assignedIds.add(desk.member.id)
        deptDesks.push(desk)
      }
    }
    if (deptDesks.length > 0) {
      deptZones.push({
        id: `dept-${dept.handle.toLowerCase()}`,
        label: dept.display_name || dept.handle,
        desks: deptDesks,
      })
    }
  }

  const remaining = members.filter((desk) => !assignedIds.has(desk.member.id))
  const personas = remaining.filter((desk) => identityOf(desk.member).role !== null)
  const clis = remaining.filter((desk) => identityOf(desk.member).role === null)
  const zones: ZoneSpec[] = [
    ...deptZones,
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
  facing?: "up" | "down"
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

export interface LayoutRoomOptions {
  departments?: readonly Department[] | undefined
  compact?: boolean | undefined
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
        const podRow = Math.floor(i / POD_COLS)
        seats.push({
          desk,
          x: pod.x + POD_PAD + (i % POD_COLS) * (DESK_W + DESK_GAP_X),
          y: pod.y + POD_PAD + podRow * (DESK_H + DESK_GAP_Y),
          scale: 1,
          facing: "down",
        })
      })
    }
    y += (rowHeights[row] ?? 0) + POD_GAP
  }
  return { id: spec.id, label: spec.label, x: 0, y: 0, w: width, h: height, pods: placedPods, seats }
}

export function layoutRoom(desks: DeskInfo[], options?: LayoutRoomOptions): RoomLayout {
  const compact = Boolean(options?.compact)
  const roomWidth = compact ? COMPACT_ROOM_W : ROOM_W
  const margin = compact ? COMPACT_MARGIN : MARGIN
  const specs = zonesOf(desks, options?.departments)
  const maxCols = compact ? 1 : specs.length === 1 ? 3 : 2
  const boxes = specs.map((spec) => boxZone(spec, maxCols))

  // Zones sit side by side and wrap to a new row when the room is full.
  // On compact viewports, each zone and pod stacks vertically.
  const rows: ZoneBox[][] = []
  let rowWidth = 0
  for (const box of boxes) {
    const last = rows.at(-1)
    if (!compact && last && rowWidth + ZONE_GAP + box.w <= roomWidth - 2 * margin) {
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
    let x = Math.max(margin, (roomWidth - total) / 2)
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
    const scale = compact ? 1.05 : DIRECTOR_SCALE
    const w = DESK_W * scale
    const h = DESK_H * scale
    const step = Math.min(w + 48, (roomWidth - 2 * margin - 40) / directors.length)
    const span = step * (directors.length - 1) + w
    const left = (roomWidth - span) / 2
    rug = { x: Math.max(margin, left - 32), y, w: Math.min(roomWidth - 2 * margin, span + 64), h: h + 28 }
    directors.forEach((desk, i) => {
      seats.push({ desk, x: left + i * step, y: y + 14, scale, facing: "up" })
    })
    y += rug.h
  }

  return { width: roomWidth, height: y + BOTTOM, zones, seats, rug }
}

export interface PlacedTaskNote extends Rect {
  note: TaskBoardNote
}

export interface PlacedTaskBoard extends Rect {
  notes: PlacedTaskNote[]
}

export interface PlacedLaneBar extends Rect {
  bar: LaneMeterBar
  fillH: number
}

export interface PlacedLaneStrip extends Rect {
  bars: PlacedLaneBar[]
}

export interface WallFixtures {
  taskBoard: PlacedTaskBoard | null
  laneStrip: PlacedLaneStrip | null
  windows: number[]
  shelves: number[]
}

const BOARD_Y = 9
const BOARD_H = 44
const BOARD_LABEL_W = 44
const BOARD_PAD = 8
const NOTE_W = 84
const NOTE_H = 32
const NOTE_GAP = 6
const BAR_W = 38
const BAR_H = 26
const BAR_GAP = 6
const BOARD_GAP = 14

function boardWidthForNotes(count: number): number {
  if (count <= 0) return 0
  return BOARD_LABEL_W + BOARD_PAD * 2 + count * NOTE_W + (count - 1) * NOTE_GAP
}

function stripWidthForBars(count: number): number {
  if (count <= 0) return 0
  return BOARD_LABEL_W + BOARD_PAD * 2 + count * BAR_W + (count - 1) * BAR_GAP
}

function overlapsRange(aStart: number, aEnd: number, bStart: number, bEnd: number, pad = 8): boolean {
  return aStart < bEnd + pad && aEnd > bStart - pad
}

// Places the task board and lane meter strip along the back wall above the room
// when they fit the available wall width, trimming non-essential windows/shelves
// that would overlap.
export function layoutWallFixtures(
  width: number,
  notes: readonly TaskBoardNote[],
  bars: readonly LaneMeterBar[],
): WallFixtures {
  const compact = width < 640
  const baseWindows = compact ? [64, 240] : [70, 210, 390, 740, 900]
  const baseShelves = compact ? [154] : [560, 1040]

  const minWallX = compact ? 52 : 200
  const maxWallX = width - (compact ? 16 : 48)
  const availW = maxWallX - minWallX

  const minOneNote = boardWidthForNotes(1)
  const minOneBar = stripWidthForBars(1)
  if (availW < Math.min(minOneNote, minOneBar)) {
    return { taskBoard: null, laneStrip: null, windows: [], shelves: [] }
  }

  const maxNoteCap = compact ? 2 : 5
  const maxBarCap = compact ? 3 : 8

  let noteCount = Math.min(notes.length, maxNoteCap)
  let barCount = Math.min(bars.length, maxBarCap)

  // Shrink counts until the combined width fits inside availW.
  while (noteCount > 0 || barCount > 0) {
    const nw = boardWidthForNotes(noteCount)
    const bw = stripWidthForBars(barCount)
    const gap = noteCount > 0 && barCount > 0 ? BOARD_GAP : 0
    if (nw + gap + bw <= availW) break
    if (barCount > noteCount && barCount > 1) {
      barCount -= 1
    } else if (noteCount > 1) {
      noteCount -= 1
    } else if (barCount > 0) {
      barCount -= 1
    } else {
      noteCount -= 1
    }
  }

  const nw = boardWidthForNotes(noteCount)
  const bw = stripWidthForBars(barCount)
  const gap = noteCount > 0 && barCount > 0 ? BOARD_GAP : 0
  const totalW = nw + gap + bw
  const startX = compact
    ? Math.max(minWallX, Math.round((width - totalW) / 2))
    : Math.max(minWallX, Math.round((minWallX + maxWallX - totalW) / 2))

  let cursorX = startX
  let taskBoard: PlacedTaskBoard | null = null
  if (noteCount > 0) {
    const placedNotes: PlacedTaskNote[] = notes.slice(0, noteCount).map((note, i) => ({
      note,
      x: cursorX + BOARD_LABEL_W + BOARD_PAD + i * (NOTE_W + NOTE_GAP),
      y: BOARD_Y + 6,
      w: NOTE_W,
      h: NOTE_H,
    }))
    taskBoard = {
      x: cursorX,
      y: BOARD_Y,
      w: nw,
      h: BOARD_H,
      notes: placedNotes,
    }
    cursorX += nw + gap
  }

  let laneStrip: PlacedLaneStrip | null = null
  if (barCount > 0) {
    const placedBars: PlacedLaneBar[] = bars.slice(0, barCount).map((bar, i) => ({
      bar,
      x: cursorX + BOARD_LABEL_W + BOARD_PAD + i * (BAR_W + BAR_GAP),
      y: BOARD_Y + 7,
      w: BAR_W,
      h: BAR_H,
      fillH: Math.max(4, Math.round(BAR_H * bar.fillRatio)),
    }))
    laneStrip = {
      x: cursorX,
      y: BOARD_Y,
      w: bw,
      h: BOARD_H,
      bars: placedBars,
    }
  }

  const occupied: Array<[number, number]> = []
  if (taskBoard) occupied.push([taskBoard.x, taskBoard.x + taskBoard.w])
  if (laneStrip) occupied.push([laneStrip.x, laneStrip.x + laneStrip.w])

  const windows = baseWindows.filter(
    (wx) => wx + 86 <= width - 16 && !occupied.some(([s, e]) => overlapsRange(wx, wx + 86, s, e)),
  )
  const shelves = baseShelves.filter(
    (sx) => sx + 84 <= width - 16 && !occupied.some(([s, e]) => overlapsRange(sx, sx + 84, s, e)),
  )

  return { taskBoard, laneStrip, windows, shelves }
}

export interface RoomArea extends Rect {
  id: string
  label: string
}

// The named areas a person can jump to: each zone, then the Director's rug.
export function roomAreas(room: Pick<RoomLayout, "zones" | "rug">): RoomArea[] {
  const areas: RoomArea[] = room.zones.map((zone) => ({ id: zone.id, label: zone.label, x: zone.x, y: zone.y, w: zone.w, h: zone.h }))
  if (room.rug) areas.push({ id: "director", label: "Director", ...room.rug })
  return areas
}

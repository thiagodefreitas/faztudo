import { DESK_H, DESK_W, type Rect, type Seat } from "../layout"

// Convert 2D SVG layout units (1200 wide) into compact 3D world meters.
export const SCALE_3D = 0.02

export function toWorld(rect: Rect, roomWidth: number, roomHeight: number): { x: number; z: number; w: number; d: number } {
  const w = rect.w * SCALE_3D
  const d = rect.h * SCALE_3D
  const x = (rect.x + rect.w / 2 - roomWidth / 2) * SCALE_3D
  const z = (rect.y + rect.h / 2 - roomHeight / 2) * SCALE_3D
  return { x, z, w, d }
}

// Agents face down the SVG, which is world +z (toward the front of the room).
// The Director faces up the SVG, which is world -z (into the room).
// The figure mesh keeps its face on local +z. rotation.y = PI sends that face to world -z.
export function seatFacingYaw(facing: "up" | "down" | undefined): number {
  return facing === "up" ? Math.PI : 0
}

// A plane's visible side is local +z. Point it at the sitter.
export function monitorScreenYaw(facing: "up" | "down" | undefined): number {
  return facing === "up" ? 0 : Math.PI
}

export interface SeatWorld {
  x: number
  z: number
  scale: number
  zSign: number
  deskOffsetZ: number
  chairOffsetZ: number
  facingYaw: number
}

export function seatWorldCoords(seat: Seat, roomWidth: number, roomHeight: number): SeatWorld {
  const { scale, facing = "down" } = seat
  const world = toWorld(
    { x: seat.x, y: seat.y, w: DESK_W * scale, h: DESK_H * scale },
    roomWidth,
    roomHeight,
  )
  const zSign = facing === "up" ? -1 : 1
  return {
    x: world.x,
    z: world.z,
    scale,
    zSign,
    deskOffsetZ: 0.16 * scale * zSign,
    chairOffsetZ: -0.44 * scale * zSign,
    facingYaw: seatFacingYaw(facing),
  }
}

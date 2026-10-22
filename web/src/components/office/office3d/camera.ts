import { SCALE_3D } from "./coords"

export interface CameraPose {
  position: [number, number, number]
  target: [number, number, number]
}

export interface CameraLimits {
  minPolar: number
  maxPolar: number
  minDistance: number
  maxDistance: number
}

export const CAMERA_LIMITS: CameraLimits = {
  minPolar: Math.PI / 7,
  maxPolar: Math.PI / 2.25,
  minDistance: 3.2,
  maxDistance: 80,
}

export const ORBIT_YAW_STEP = Math.PI / 36
export const ORBIT_PITCH_STEP = Math.PI / 48
export const ZOOM_STEP = 0.8
export const INTRO_MS = 1400
export const GLIDE_MS = 900

export interface OrbitDelta {
  yaw: number
  pitch: number
  radiusDelta: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function poseRadius(pose: CameraPose): number {
  const dx = pose.position[0] - pose.target[0]
  const dy = pose.position[1] - pose.target[1]
  const dz = pose.position[2] - pose.target[2]
  return Math.hypot(dx, dy, dz)
}

// Computes a smooth starting camera position that frames the entire room.
export function defaultCameraPose(roomWidth: number, roomHeight: number, aspect = 1.6): CameraPose {
  const floorW = roomWidth * SCALE_3D
  const floorD = roomHeight * SCALE_3D
  const span = Math.max(floorW * 0.68, floorD * 1.05, 10)
  const y = Math.round((span * 0.62 + 1.8) * 100) / 100
  const z = Math.round((span * 0.78 + 2.4) * 100) / 100
  const target: [number, number, number] = [0, 0.2, 0.3]
  const baseRadius = Math.hypot(y - target[1], z - target[2])
  const halfV = Math.tan((38 * Math.PI) / 360)
  const safeAspect = aspect > 0 && Number.isFinite(aspect) ? aspect : 1.6
  const neededRadius = Math.max(
    (floorW * 1.3) / (2 * halfV * safeAspect),
    (floorD * 0.85 * 1.3) / (2 * halfV),
  )
  const scale = Math.max(1, neededRadius / baseRadius)
  return {
    position: [0, target[1] + (y - target[1]) * scale, target[2] + (z - target[2]) * scale],
    target,
  }
}

export function clampCameraPose(pose: CameraPose, limits: CameraLimits = CAMERA_LIMITS): CameraPose {
  const dx = pose.position[0] - pose.target[0]
  const dy = pose.position[1] - pose.target[1]
  const dz = pose.position[2] - pose.target[2]
  const radius = Math.hypot(dx, dy, dz) || limits.minDistance
  const polar = Math.acos(clamp(dy / radius, -1, 1))
  const azimuth = Math.atan2(dx, dz)
  const nextRadius = clamp(radius, limits.minDistance, limits.maxDistance)
  const nextPolar = clamp(polar, limits.minPolar, limits.maxPolar)
  const sinP = Math.sin(nextPolar)
  return {
    position: [
      pose.target[0] + nextRadius * sinP * Math.sin(azimuth),
      pose.target[1] + nextRadius * Math.cos(nextPolar),
      pose.target[2] + nextRadius * sinP * Math.cos(azimuth),
    ],
    target: [pose.target[0], pose.target[1], pose.target[2]],
  }
}

// Pull back and up along the overview ray for the first-load move.
export function introCameraPose(settled: CameraPose, limits: CameraLimits = CAMERA_LIMITS): CameraPose {
  const dx = settled.position[0] - settled.target[0]
  const dy = settled.position[1] - settled.target[1]
  const dz = settled.position[2] - settled.target[2]
  const pull = 1.22
  return clampCameraPose(
    {
      position: [
        settled.target[0] + dx * pull,
        settled.target[1] + dy * pull + 1.1,
        settled.target[2] + dz * pull,
      ],
      target: [settled.target[0], settled.target[1], settled.target[2]],
    },
    limits,
  )
}

export function openingCameraPose(settled: CameraPose, reducedMotion: boolean, limits?: CameraLimits): CameraPose {
  if (reducedMotion) return settled
  return introCameraPose(settled, limits)
}

export interface DeskAnchor {
  x: number
  z: number
  facing?: "up" | "down" | undefined
  scale?: number | undefined
}

// Frame one desk from in front of the sitter so the glide lands on their face and desk.
export function deskCameraPose(anchor: DeskAnchor, limits: CameraLimits = CAMERA_LIMITS): CameraPose {
  const scale = anchor.scale ?? 1
  const forwardZ = anchor.facing === "up" ? -1 : 1
  const lookY = 0.78 * scale
  return clampCameraPose(
    {
      target: [anchor.x, lookY, anchor.z],
      position: [anchor.x + 1.05, lookY + 1.65, anchor.z + forwardZ * 4.4],
    },
    limits,
  )
}

export interface AreaFrame {
  // Center and size of the area on the floor, in world meters.
  x: number
  z: number
  w: number
  d: number
}

const CANVAS_FOV_DEG = 38
const AREA_MARGIN_3D = 1.2

// Frame a zone or the Director rug from the direction the overview looks from,
// close enough that the area fills the view with a margin. aspect is the canvas
// width over its height.
export function areaCameraPose(
  area: AreaFrame,
  overview: CameraPose,
  aspect = 1.6,
  limits: CameraLimits = CAMERA_LIMITS,
): CameraPose {
  const target: [number, number, number] = [area.x, 0.2, area.z]
  const dx = overview.position[0] - overview.target[0]
  const dy = overview.position[1] - overview.target[1]
  const dz = overview.position[2] - overview.target[2]
  const length = Math.hypot(dx, dy, dz) || 1
  const halfV = Math.tan((CANVAS_FOV_DEG * Math.PI) / 360)
  const halfH = halfV * (aspect > 0 && Number.isFinite(aspect) ? aspect : 1.6)
  // The floor is seen at a slant, so its depth takes up less of the view than its width.
  const slant = Math.max(0.5, dy / length)
  const radius = Math.max((area.w * AREA_MARGIN_3D) / (2 * halfH), (area.d * AREA_MARGIN_3D * slant) / (2 * halfV))
  return clampCameraPose(
    {
      target,
      position: [target[0] + (dx / length) * radius, target[1] + (dy / length) * radius, target[2] + (dz / length) * radius],
    },
    limits,
  )
}

export function smoothstep01(t: number): number {
  const x = clamp(t, 0, 1)
  return x * x * (3 - 2 * x)
}

export function sampleCameraGlide(from: CameraPose, to: CameraPose, t: number): CameraPose {
  const eased = smoothstep01(t)
  const lerp = (a: number, b: number) => a + (b - a) * eased
  return {
    position: [
      lerp(from.position[0], to.position[0]),
      lerp(from.position[1], to.position[1]),
      lerp(from.position[2], to.position[2]),
    ],
    target: [lerp(from.target[0], to.target[0]), lerp(from.target[1], to.target[1]), lerp(from.target[2], to.target[2])],
  }
}

// Positive yaw moves a camera that sits on +z toward +x (counter-clockwise from +z).
// Positive pitch increases the polar angle, which lowers the camera.
// Positive radiusDelta moves the camera away from the target.
export function applyCameraOrbit(
  pose: CameraPose,
  delta: OrbitDelta,
  limits: CameraLimits = CAMERA_LIMITS,
): CameraPose {
  const dx = pose.position[0] - pose.target[0]
  const dy = pose.position[1] - pose.target[1]
  const dz = pose.position[2] - pose.target[2]
  const radius = Math.hypot(dx, dy, dz) || limits.minDistance
  const polar = Math.acos(clamp(dy / radius, -1, 1))
  const azimuth = Math.atan2(dx, dz)
  const nextRadius = radius + delta.radiusDelta
  const nextPolar = polar + delta.pitch
  const nextAzimuth = azimuth + delta.yaw
  const sinP = Math.sin(nextPolar)
  return clampCameraPose(
    {
      target: [pose.target[0], pose.target[1], pose.target[2]],
      position: [
        pose.target[0] + nextRadius * sinP * Math.sin(nextAzimuth),
        pose.target[1] + nextRadius * Math.cos(nextPolar),
        pose.target[2] + nextRadius * sinP * Math.cos(nextAzimuth),
      ],
    },
    limits,
  )
}

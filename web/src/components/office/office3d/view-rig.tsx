import { OrbitControls } from "@react-three/drei"
import { useFrame } from "@react-three/fiber"
import { useMemo, useRef, type RefObject } from "react"
import { Vector3 } from "three"
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib"
import {
  applyCameraOrbit,
  CAMERA_LIMITS,
  GLIDE_MS,
  INTRO_MS,
  introCameraPose,
  sampleCameraGlide,
  type CameraPose,
  type OrbitDelta,
} from "./camera"
import { layoutNameLabels, type NameLabelBox, type NameLabelPlacement } from "./labels"

function readPose(controls: OrbitControlsImpl): CameraPose {
  const position = controls.object.position
  const target = controls.target
  return {
    position: [position.x, position.y, position.z],
    target: [target.x, target.y, target.z],
  }
}

function writePose(controls: OrbitControlsImpl, pose: CameraPose) {
  controls.target.set(pose.target[0], pose.target[1], pose.target[2])
  controls.object.position.set(pose.position[0], pose.position[1], pose.position[2])
  controls.update()
}

export function CameraRig({
  overview,
  destination,
  moveToken,
  orbitNonce,
  reducedMotion,
  orbitDeltaRef,
  onMovingChange,
}: {
  overview: CameraPose
  destination: CameraPose
  moveToken: number
  orbitNonce: number
  reducedMotion: boolean
  orbitDeltaRef: RefObject<OrbitDelta>
  onMovingChange: (moving: boolean) => void
}) {
  const controlsRef = useRef<OrbitControlsImpl | null>(null)
  const glideRef = useRef<{ from: CameraPose; to: CameraPose; start: number; dur: number } | null>(null)
  const introDone = useRef(false)
  const moveSeen = useRef(0)

  useFrame(() => {
    const controls = controlsRef.current
    const delta = orbitDeltaRef.current
    if (!controls || !delta || orbitNonce < 0) return
    if (delta.yaw !== 0 || delta.pitch !== 0 || delta.radiusDelta !== 0) {
      const next = applyCameraOrbit(readPose(controls), delta)
      delta.yaw = 0
      delta.pitch = 0
      delta.radiusDelta = 0
      glideRef.current = null
      introDone.current = true
      moveSeen.current = moveToken
      writePose(controls, next)
      onMovingChange(false)
      return
    }
    if (!introDone.current) {
      introDone.current = true
      moveSeen.current = moveToken
      if (reducedMotion) {
        writePose(controls, destination)
        glideRef.current = null
        onMovingChange(false)
        return
      }
      const from = introCameraPose(overview)
      writePose(controls, from)
      glideRef.current = { from, to: destination, start: performance.now(), dur: INTRO_MS }
      onMovingChange(true)
      return
    }
    if (moveSeen.current !== moveToken) {
      moveSeen.current = moveToken
      if (reducedMotion) {
        writePose(controls, destination)
        glideRef.current = null
        onMovingChange(false)
        return
      }
      const from = readPose(controls)
      glideRef.current = { from, to: destination, start: performance.now(), dur: GLIDE_MS }
      onMovingChange(true)
    }
    const glide = glideRef.current
    if (!glide) return
    const t = (performance.now() - glide.start) / glide.dur
    if (t >= 1) {
      writePose(controls, glide.to)
      glideRef.current = null
      onMovingChange(false)
      return
    }
    writePose(controls, sampleCameraGlide(glide.from, glide.to, t))
  })

  return (
    <OrbitControls
      ref={controlsRef}
      enablePan
      enableZoom
      enableRotate
      enableDamping={!reducedMotion}
      minPolarAngle={CAMERA_LIMITS.minPolar}
      maxPolarAngle={CAMERA_LIMITS.maxPolar}
      minDistance={CAMERA_LIMITS.minDistance}
      maxDistance={CAMERA_LIMITS.maxDistance}
      onStart={() => {
        if (!glideRef.current) return
        glideRef.current = null
        onMovingChange(false)
      }}
    />
  )
}

export interface LabelAnchor {
  id: string
  x: number
  y: number
  z: number
  // Zone names yield to desk labels, so a far desk name is hidden before a zone title covers it.
  yield?: boolean
  // Screen-space half size. A name is one line; approval and quota stacks are taller.
  halfW?: number
  halfH?: number
}

export function NameLabelDriver({
  anchors,
  placementsRef,
}: {
  anchors: readonly LabelAnchor[]
  placementsRef: RefObject<Map<string, NameLabelPlacement>>
}) {
  const scratch = useMemo(() => ({ world: new Vector3(), ndc: new Vector3() }), [])

  useFrame(({ camera, size }) => {
    const map = placementsRef.current
    if (!map) return
    const boxes: NameLabelBox[] = anchors.map((anchor) => {
      scratch.world.set(anchor.x, anchor.y, anchor.z)
      const depth = camera.position.distanceTo(scratch.world) + (anchor.yield ? 800 : 0)
      scratch.ndc.copy(scratch.world).project(camera)
      return {
        id: anchor.id,
        x: (scratch.ndc.x * 0.5 + 0.5) * size.width,
        y: (-scratch.ndc.y * 0.5 + 0.5) * size.height,
        halfW: anchor.halfW ?? (anchor.yield ? 40 : 52),
        halfH: anchor.halfH ?? (anchor.yield ? 11 : 14),
        depth,
      }
    })
    map.clear()
    for (const item of layoutNameLabels(boxes)) map.set(item.id, item)
  })

  return null
}

// Applies the collision shift from inside the canvas. The label DOM is portaled by Html,
// so this hook must run on a canvas child, not inside that portal.
export function LabelPlacement<T extends HTMLElement>({
  id,
  placementsRef,
  targetRef,
}: {
  id: string
  placementsRef: RefObject<Map<string, NameLabelPlacement>>
  targetRef: RefObject<T | null>
}) {
  useFrame(() => {
    const el = targetRef.current
    const place = placementsRef.current?.get(id)
    if (!el || !place) return
    const hidden = place.opacity < 0.5
    el.style.opacity = hidden ? "0" : "1"
    el.style.visibility = hidden ? "hidden" : "visible"
    el.style.pointerEvents = hidden ? "none" : "auto"
    el.style.transform =
      place.offsetX === 0 && place.offsetY === 0 ? "" : `translate(${place.offsetX}px, ${place.offsetY}px)`
  })
  return null
}

import { Object3D, Vector3 } from "three"
import { describe, expect, it } from "vitest"
import type { Member, StreamEvent } from "../../../types"
import { layoutRoom } from "../layout"
import { deriveMemberDesk, deriveOfficeDesks } from "../state"
import {
  applyCameraOrbit,
  areaCameraPose,
  CAMERA_LIMITS,
  defaultCameraPose,
  deskCameraPose,
  introCameraPose,
  openingCameraPose,
  ORBIT_PITCH_STEP,
  ORBIT_YAW_STEP,
  poseRadius,
  sampleCameraGlide,
  ZOOM_STEP,
} from "./camera"
import { monitorScreenYaw, seatFacingYaw, seatWorldCoords } from "./coords"
import { cycleDeskIndex, mapOfficeKey } from "./input"
import { FLOOR_LABEL_CLEAR_Y, floorLabelAnchor, layoutNameLabels } from "./labels"
import { activeMentionIds, approvalCardOffsetY, MENTION_PULSE_MS, mentionRecordsFromEvents, nextCodeScroll } from "./life"
import { deriveCharacterPose, sampleCharacterFrame } from "./poses"

const now = Date.parse("2026-10-18T12:00:00.000Z")

const members: Member[] = [
  { id: "m-director", kind: "human", handle: "director", display_name: "Director", presence: "online" },
  { id: "m-claude", kind: "agent", handle: "claude", display_name: "Claude", presence: "online" },
  { id: "m-coder", kind: "agent", handle: "coder", display_name: "Coder", presence: "online", agent: { lanes: ["codex/default"], role: "coder" } },
]

function worldAxis(yaw: number, local: [number, number, number]): Vector3 {
  const obj = new Object3D()
  obj.rotation.y = yaw
  obj.updateWorldMatrix(true, false)
  return new Vector3(local[0], local[1], local[2]).applyQuaternion(obj.quaternion)
}

describe("office camera", () => {
  it("pulls the overview back on a narrow canvas", () => {
    const wide = defaultCameraPose(1200, 800, 1.6)
    const phone = defaultCameraPose(1200, 800, 0.55)
    expect(poseRadius(phone)).toBeGreaterThan(poseRadius(wide))
    expect(phone.target).toEqual(wide.target)
  })
  it("pulls the intro back from the overview and skips it under reduced motion", () => {
    const settled = defaultCameraPose(1200, 800)
    const intro = introCameraPose(settled)
    expect(poseRadius(intro)).toBeGreaterThan(poseRadius(settled))
    expect(intro.target).toEqual(settled.target)
    expect(openingCameraPose(settled, true)).toEqual(settled)
    expect(sampleCameraGlide(intro, settled, 0).position).toEqual(intro.position)
    expect(sampleCameraGlide(intro, settled, 1).position[2]).toBeCloseTo(settled.position[2])
    const mid = sampleCameraGlide(intro, settled, 0.5)
    expect(mid.position[2]).toBeLessThan(intro.position[2])
    expect(mid.position[2]).toBeGreaterThan(settled.position[2])
  })

  it("frames a desk from in front of the sitter and orbits with a fixed yaw sign", () => {
    const agent = deskCameraPose({ x: 2, z: -1, facing: "down", scale: 1 })
    expect(agent.target[0]).toBeCloseTo(2)
    expect(agent.target[2]).toBeCloseTo(-1)
    expect(agent.position[2]).toBeGreaterThan(agent.target[2])

    const director = deskCameraPose({ x: 0, z: 4, facing: "up", scale: 1.2 })
    expect(director.position[2]).toBeLessThan(director.target[2])
    expect(poseRadius(director)).toBeGreaterThan(3.2)

    const turned = applyCameraOrbit(
      { position: [0, 10, 10], target: [0, 0, 0] },
      { yaw: Math.PI / 2, pitch: 0, radiusDelta: 0 },
    )
    expect(turned.position[0]).toBeCloseTo(10)
    expect(turned.position[1]).toBeCloseTo(10)
    expect(turned.position[2]).toBeCloseTo(0)
    expect(turned.target).toEqual([0, 0, 0])

    const closer = applyCameraOrbit(
      { position: [0, 10, 10], target: [0, 0, 0] },
      { yaw: 0, pitch: 0, radiusDelta: -2 },
    )
    expect(poseRadius(closer)).toBeCloseTo(Math.hypot(10, 10) - 2)
  })

  it("points the Director into the room and the monitor at the sitter", () => {
    const desks = deriveOfficeDesks({ members, runs: [], approvals: [], lanes: [], now })
    const room = layoutRoom(desks)
    const directorSeat = room.seats.find((seat) => seat.desk.isDirector)
    const agentSeat = room.seats.find((seat) => seat.desk.member.id === "m-claude")
    expect(directorSeat?.facing).toBe("up")
    expect(agentSeat?.facing).toBe("down")
    if (!directorSeat || !agentSeat) return

    const directorCoords = seatWorldCoords(directorSeat, room.width, room.height)
    const agentCoords = seatWorldCoords(agentSeat, room.width, room.height)
    const directorForward = worldAxis(directorCoords.facingYaw, [0, 0, 1])
    const agentForward = worldAxis(agentCoords.facingYaw, [0, 0, 1])
    const directorChairZ = directorCoords.z + directorCoords.chairOffsetZ
    const agentChairZ = agentCoords.z + agentCoords.chairOffsetZ

    expect(directorForward.z).toBeCloseTo(-1)
    expect(directorForward.x).toBeCloseTo(0)
    expect((0 - directorChairZ) * directorForward.z).toBeGreaterThan(0)
    expect((directorCoords.z + directorCoords.deskOffsetZ - directorChairZ) * directorForward.z).toBeGreaterThan(0)

    expect(agentForward.z).toBeCloseTo(1)
    expect((agentCoords.z + agentCoords.deskOffsetZ - agentChairZ) * agentForward.z).toBeGreaterThan(0)

    const directorScreen = worldAxis(monitorScreenYaw(directorSeat.facing), [0, 0, 1])
    const agentScreen = worldAxis(monitorScreenYaw(agentSeat.facing), [0, 0, 1])
    expect(directorScreen.dot(directorForward)).toBeLessThan(0)
    expect(agentScreen.dot(agentForward)).toBeLessThan(0)
    expect(seatFacingYaw("up")).toBe(Math.PI)
    expect(seatFacingYaw("down")).toBe(0)
  })
})

describe("office area framing", () => {
  const overview = defaultCameraPose(1200, 600)

  it("looks at the area's center from the overview's direction, closer than the overview", () => {
    const pose = areaCameraPose({ x: -4, z: 1, w: 5, d: 4 }, overview)
    expect(pose.target[0]).toBe(-4)
    expect(pose.target[2]).toBe(1)
    expect(poseRadius(pose)).toBeLessThan(poseRadius(overview))
    const side = (p: typeof pose) => Math.sign(p.position[2] - p.target[2])
    expect(side(pose)).toBe(side(overview))
  })

  it("steps back for a bigger area and a narrower canvas", () => {
    const small = poseRadius(areaCameraPose({ x: 0, z: 0, w: 4, d: 3 }, overview))
    const big = poseRadius(areaCameraPose({ x: 0, z: 0, w: 8, d: 6 }, overview))
    const narrow = poseRadius(areaCameraPose({ x: 0, z: 0, w: 4, d: 3 }, overview, 0.7))
    expect(big).toBeGreaterThan(small)
    expect(narrow).toBeGreaterThan(small)
  })

  it("stays inside the camera limits for a tiny or a huge area", () => {
    const tiny = poseRadius(areaCameraPose({ x: 0, z: 0, w: 0.1, d: 0.1 }, overview))
    const huge = poseRadius(areaCameraPose({ x: 0, z: 0, w: 400, d: 400 }, overview))
    expect(tiny).toBeGreaterThanOrEqual(CAMERA_LIMITS.minDistance - 1e-6)
    expect(huge).toBeLessThanOrEqual(CAMERA_LIMITS.maxDistance + 1e-6)
  })
})

describe("office name labels", () => {
  it("keeps separated labels, shifts a label behind another, and fades one that cannot move clear", () => {
    const clear = layoutNameLabels([
      { id: "a", x: 0, y: 0, halfW: 10, halfH: 8, depth: 3 },
      { id: "b", x: 80, y: 0, halfW: 10, halfH: 8, depth: 4 },
    ])
    expect(clear).toEqual([
      { id: "a", offsetX: 0, offsetY: 0, opacity: 1 },
      { id: "b", offsetX: 0, offsetY: 0, opacity: 1 },
    ])

    const stacked = layoutNameLabels([
      { id: "far", x: 0, y: 0, halfW: 20, halfH: 10, depth: 9 },
      { id: "near", x: 4, y: 2, halfW: 20, halfH: 10, depth: 2 },
    ])
    expect(stacked.find((item) => item.id === "near")).toMatchObject({ offsetY: 0, opacity: 1 })
    const far = stacked.find((item) => item.id === "far")
    expect(far?.opacity).toBe(1)
    expect(far?.offsetY).not.toBe(0)

    const blocked = layoutNameLabels([
      { id: "near", x: 0, y: 0, halfW: 30, halfH: 40, depth: 1 },
      { id: "far", x: 0, y: 0, halfW: 30, halfH: 40, depth: 6 },
    ])
    expect(blocked.find((item) => item.id === "near")?.opacity).toBe(1)
    expect(blocked.find((item) => item.id === "far")?.opacity).toBe(0)
  })

  it("clamps labels within a phone canvas and hides zone titles that meet desk labels", () => {
    const placed = layoutNameLabels([
      { id: "left", x: 2, y: 60, halfW: 70, halfH: 14, depth: 2 },
      { id: "right", x: 388, y: 60, halfW: 70, halfH: 14, depth: 3 },
      { id: "zone", x: 2, y: 60, halfW: 45, halfH: 12, depth: 900, yield: true },
    ], { width: 390, height: 300 })
    expect(placed.find((item) => item.id === "left")?.offsetX).toBe(74)
    expect(placed.find((item) => item.id === "right")?.offsetX).toBe(-74)
    expect(placed.find((item) => item.id === "zone")?.opacity).toBe(0)
  })

  it("lifts pod and department anchors above the desks", () => {
    const zone = floorLabelAnchor({ x: 0, z: 0, w: 4, d: 3 }, "zone")
    const pod = floorLabelAnchor({ x: 0, z: 0, w: 4, d: 3 }, "pod")
    const director = floorLabelAnchor({ x: 1, z: 2, w: 3, d: 2 }, "director")
    for (const anchor of [zone, pod, director]) {
      expect(anchor.y).toBeGreaterThanOrEqual(FLOOR_LABEL_CLEAR_Y)
    }
    expect(pod.y).toBeLessThan(zone.y)
    expect(zone.z).toBeGreaterThan(-1.5)
    expect(zone.z).toBeLessThan(1.5)
    expect(zone.x).toBeGreaterThan(-2)
    expect(zone.x).toBeLessThan(2)
  })
})

describe("office keyboard map", () => {
  it("maps arrows to orbit, +/- to zoom, Tab to desk cycle, and Escape to reset", () => {
    expect(mapOfficeKey({ key: "ArrowLeft" })).toEqual({ type: "orbit", yaw: -ORBIT_YAW_STEP, pitch: 0 })
    expect(mapOfficeKey({ key: "ArrowRight" })).toEqual({ type: "orbit", yaw: ORBIT_YAW_STEP, pitch: 0 })
    expect(mapOfficeKey({ key: "ArrowUp" })).toEqual({ type: "orbit", yaw: 0, pitch: -ORBIT_PITCH_STEP })
    expect(mapOfficeKey({ key: "ArrowDown" })).toEqual({ type: "orbit", yaw: 0, pitch: ORBIT_PITCH_STEP })
    expect(mapOfficeKey({ key: "+" })).toEqual({ type: "zoom", radiusDelta: -ZOOM_STEP })
    expect(mapOfficeKey({ key: "=" })).toEqual({ type: "zoom", radiusDelta: -ZOOM_STEP })
    expect(mapOfficeKey({ key: "-" })).toEqual({ type: "zoom", radiusDelta: ZOOM_STEP })
    expect(mapOfficeKey({ key: "Tab" })).toEqual({ type: "cycle", delta: 1 })
    expect(mapOfficeKey({ key: "Tab", shiftKey: true })).toEqual({ type: "cycle", delta: -1 })
    expect(mapOfficeKey({ key: "Escape" })).toEqual({ type: "reset" })
    expect(mapOfficeKey({ key: "ArrowLeft", metaKey: true })).toBeNull()
    expect(mapOfficeKey({ key: "k" })).toBeNull()

    expect(cycleDeskIndex(4, -1, 1)).toBe(0)
    expect(cycleDeskIndex(4, -1, -1)).toBe(3)
    expect(cycleDeskIndex(4, 0, -1)).toBe(3)
    expect(cycleDeskIndex(4, 3, 1)).toBe(0)
  })
})

describe("office life", () => {
  it("breathes and turns the idle head, and holds still under reduced motion", () => {
    const desk = deriveMemberDesk({ member: members[1]!, runs: [], approvals: [], lanes: [], now })
    const idle = deriveCharacterPose(desk, { reducedMotion: false })
    expect(sampleCharacterFrame(idle, 1, 0).headYaw).toBe(0)
    expect(sampleCharacterFrame(idle, 3.7, 0).headYaw).not.toBe(0)
    expect(sampleCharacterFrame(idle, 3.7, 0).breath).not.toBe(0)
    expect(sampleCharacterFrame(idle, 9.5, 0).dozing).toBe(true)
    const still = deriveCharacterPose(desk, { reducedMotion: true })
    expect(sampleCharacterFrame(still, 3.7, 0)).toMatchObject({ headYaw: 0, breath: 0, dozing: false })
    expect(approvalCardOffsetY(0.4, false, 1)).not.toBe(0)
    expect(approvalCardOffsetY(0.4, true, 1)).toBe(0)
    expect(nextCodeScroll(0.2, 0.5, true)).toBe(0.2)
    expect(nextCodeScroll(0.02, 1, false)).toBeGreaterThanOrEqual(0)
    expect(nextCodeScroll(0.02, 1, false)).toBeLessThan(1)
  })

  it("pulses desks mentioned in the last minute", () => {
    const event: StreamEvent = {
      seq: 1,
      id: "ev-mention",
      version: 1,
      type: "message.posted",
      actor: "director",
      ts: new Date(now).toISOString(),
      payload: { mentions: ["m-coder"], body: "take a look @claude" },
    }
    const records = mentionRecordsFromEvents([event], members)
    expect(activeMentionIds(records, now + 1_000).sort()).toEqual(["m-claude", "m-coder"])
    expect(activeMentionIds(records, now + MENTION_PULSE_MS)).toEqual([])
    expect(activeMentionIds(records, now + MENTION_PULSE_MS - 1).length).toBe(2)
  })
})

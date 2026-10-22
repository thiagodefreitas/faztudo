import * as Dialog from "@radix-ui/react-dialog"
import { Billboard, Edges, Html } from "@react-three/drei"
import type { GridHelper } from "three"
import { Canvas } from "@react-three/fiber"
import { useQueryClient } from "@tanstack/react-query"
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react"
import { api } from "../../../api/client"
import type { ThemeChoice } from "../../../lib/theme"
import { onStreamEvent } from "../../../state/bus"
import { useOpenDirect } from "../../../state/direct"
import { qk } from "../../../state/keys"
import { replaceById } from "../../../state/merge"
import type { Approval, Channel, Department, Lane, Member, Run, StreamEvent } from "../../../types"
import { AgentAvatar } from "../../agent-avatar"
import { WorkspaceNav } from "../../sidebar"
import { avatarState } from "../avatar"
import { layoutRoom, type PlacedZone, type Rect, type RoomArea, roomAreas, type Seat } from "../layout"
import { DeskDetailPanel, deskMatchesLegend, Legend, type LegendKey, OfficeViewToggle, toggleLegendKey } from "../scene"
import { type DeskInfo, useOfficeDesks, useReducedMotion } from "../state"
import { ZoomControls } from "../zoom-controls"
import {
  createAnimationQueue,
  enqueueOfficeEvent,
  type HandoffAnimation,
  type MergeAnimation,
  type OfficeAnimationQueue,
  pruneAnimationQueue,
} from "./animations"
import {
  CharacterSeatGroup,
  InstancedDeskFurniture,
  LaneMeterStrip3D,
  seatWorldCoords,
  TaskBoard3D,
  WalkingHandoffActor3D,
} from "./character-mesh"
import { CodeScreenDriver } from "./code-screen"
import { SCALE_3D, toWorld } from "./coords"
import { cycleDeskIndex, isTypingTarget, mapOfficeKey } from "./input"
import {
  activeMentionIds,
  MENTION_PULSE_MS,
  mentionRecordsFromEvent,
  mentionRecordsFromEvents,
  type MentionRecord,
} from "./life"
import { directorLabelAnchor, zoneLabelAnchor, type NameLabelPlacement } from "./labels"
import {
  deriveCharacterIdentity,
  deriveCharacterPose,
  deriveLaneMeterBars,
  deriveTaskBoardNotes,
  deriveTimeOfDayLighting,
  type LaneMeterBar,
  type TaskBoardNote,
  type TimeOfDayLighting,
} from "./poses"
import { CameraRig, type LabelAnchor, LabelPlacement, NameLabelDriver } from "./view-rig"
import {
  areaCameraPose,
  defaultCameraPose,
  deskCameraPose,
  openingCameraPose,
  type CameraPose,
  type OrbitDelta,
} from "./camera"

export * from "./animations"
export * from "./poses"
export { SCALE_3D, toWorld } from "./coords"
export { defaultCameraPose } from "./camera"
export type { CameraPose } from "./camera"

export interface ScenePalette {
  canvas: string
  surface: string
  sidebar: string
  line: string
  ink: string
  faint: string
  accent: string
  accentSoft: string
  warn: string
  danger: string
  code: string
  deskTop: string
  deskBody: string
  chair: string
  directorTop: string
  hemiSky: string
  hemiGround: string
  keyLight: string
  hemiIntensity: number
  keyIntensity: number
}

export const OFFICE_MAX_DPR = 1.5

const ZONE_TINTS: Record<ThemeChoice, readonly string[]> = {
  light: ["#d5efe8", "#f4e4c8", "#d5e2f6", "#f4dbe6", "#d5f0e0"],
  dark: ["#16302c", "#2c261c", "#1a2430", "#2a1c26", "#14261c"],
}

export const SCENE_PALETTES: Record<ThemeChoice, ScenePalette> = {
  light: {
    canvas: "#f7f9fa",
    surface: "#ffffff",
    sidebar: "#eef2f5",
    line: "#dfe6eb",
    ink: "#11181c",
    faint: "#576670",
    accent: "#0e7c74",
    accentSoft: "#dff3f0",
    warn: "#8a4b08",
    danger: "#b42318",
    code: "#eef2f5",
    deskTop: "#efe2d0",
    deskBody: "#c9ae90",
    chair: "#a67c52",
    directorTop: "#d7efe9",
    hemiSky: "#fffdf8",
    hemiGround: "#e7dfd4",
    keyLight: "#fff6ea",
    hemiIntensity: 1.35,
    keyIntensity: 1.15,
  },
  dark: {
    canvas: "#141c21",
    surface: "#1f2a32",
    sidebar: "#0f1417",
    line: "#33424d",
    ink: "#edf2f4",
    faint: "#84949e",
    accent: "#5cd6c8",
    accentSoft: "#153533",
    warn: "#f5b942",
    danger: "#f97066",
    code: "#0b0f12",
    deskTop: "#3c342c",
    deskBody: "#2a241e",
    chair: "#5c4d40",
    directorTop: "#1d3d38",
    hemiSky: "#d7e6f0",
    hemiGround: "#2a241e",
    keyLight: "#f4efe6",
    hemiIntensity: 1.55,
    keyIntensity: 1.3,
  },
}

export function isWebGLAvailable(): boolean {
  if (typeof window === "undefined" || typeof document === "undefined") return false
  if (typeof window.WebGLRenderingContext === "undefined") return false
  try {
    const canvas = document.createElement("canvas")
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl") ?? canvas.getContext("experimental-webgl")
    return Boolean(gl)
  } catch {
    return false
  }
}

function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() => typeof document === "undefined" || !document.hidden)
  useEffect(() => {
    const onChange = () => setVisible(!document.hidden)
    document.addEventListener("visibilitychange", onChange)
    return () => document.removeEventListener("visibilitychange", onChange)
  }, [])
  return visible
}

function FloorName({
  id,
  position,
  placementsRef,
  testId,
  label,
  className,
  onClick,
}: {
  id: string
  position: [number, number, number]
  placementsRef: RefObject<Map<string, NameLabelPlacement>>
  testId: string
  label: string
  className: string
  onClick: () => void
}) {
  const ref = useRef<HTMLButtonElement>(null)
  return (
    <group>
      <LabelPlacement id={id} placementsRef={placementsRef} targetRef={ref} />
      <Billboard position={position}>
        <Html center transform={false} zIndexRange={[5, 0]}>
          <button
            ref={ref}
            type="button"
            data-testid={testId}
            aria-label={`Zoom to ${label}`}
            onClick={onClick}
            className={className}
          >
            {label}
          </button>
        </Html>
      </Billboard>
    </group>
  )
}

function RoomWorld({
  width,
  height,
  zones,
  rug,
  seats,
  palette,
  theme,
  lighting,
  taskNotes,
  laneBars,
  handoffs,
  mergesByMember,
  now,
  selectedId,
  focusedId,
  mentionIds,
  reducedMotion,
  overviewPose,
  destinationPose,
  moveToken,
  orbitNonce,
  orbitDeltaRef,
  onCameraMovingChange,
  onSelect,
  onOpenApproval,
  onFocusArea,
}: {
  width: number
  height: number
  zones: PlacedZone[]
  rug: Rect | null
  seats: Seat[]
  palette: ScenePalette
  theme: ThemeChoice
  lighting: TimeOfDayLighting
  taskNotes: TaskBoardNote[]
  laneBars: LaneMeterBar[]
  handoffs: HandoffAnimation[]
  mergesByMember: ReadonlyMap<string, MergeAnimation>
  now: number
  selectedId: string | null
  focusedId: string | null
  mentionIds: ReadonlySet<string>
  reducedMotion: boolean
  overviewPose: CameraPose
  destinationPose: CameraPose
  moveToken: number
  orbitNonce: number
  orbitDeltaRef: RefObject<OrbitDelta>
  onCameraMovingChange: (moving: boolean) => void
  onSelect: (desk: DeskInfo) => void
  onOpenApproval?: ((desk: DeskInfo) => void) | undefined
  onFocusArea: (area: RoomArea) => void
}) {
  const floorW = width * SCALE_3D
  const floorD = height * SCALE_3D
  const wallH = 1.25
  const wallT = 0.22
  const gridSize = Math.ceil(Math.max(floorW, floorD))
  const gridDivisions = Math.max(12, Math.round(gridSize / 0.8))
  const placementsRef = useRef(new Map<string, NameLabelPlacement>())
  const gridRef = useRef<GridHelper>(null)
  const zoneTints = ZONE_TINTS[theme]

  useLayoutEffect(() => {
    const material = gridRef.current?.material
    const mats = Array.isArray(material) ? material : material ? [material] : []
    for (const mat of mats) {
      mat.transparent = true
      mat.opacity = 0.28
    }
  }, [gridSize, gridDivisions, palette.line])

  const seatsByMember = useMemo(() => {
    const map = new Map<string, Seat>()
    for (const seat of seats) {
      map.set(seat.desk.member.id, seat)
    }
    return map
  }, [seats])

  const walkingIds = useMemo(() => {
    const ids = new Set<string>()
    for (const h of handoffs) {
      ids.add(h.fromMemberId)
    }
    return ids
  }, [handoffs])

  const labelAnchors = useMemo(() => {
    const anchors: LabelAnchor[] = seats.map((seat) => {
      const coords = seatWorldCoords(seat, width, height)
      const stacked = seat.desk.state === "waiting_approval" || seat.desk.state === "out_of_quota"
      return {
        id: seat.desk.member.id,
        x: coords.x,
        y: 1.38 * coords.scale,
        z: coords.z + coords.chairOffsetZ,
        halfW: stacked ? 64 : 52,
        halfH: stacked ? 28 : 14,
      }
    })
    for (const zone of zones) {
      const anchor = zoneLabelAnchor(toWorld(zone, width, height))
      anchors.push({ id: `zone-${zone.id}`, x: anchor.x, y: anchor.y + 0.28, z: anchor.z, yield: true })
    }
    if (rug) {
      const anchor = directorLabelAnchor(toWorld(rug, width, height))
      anchors.push({ id: "zone-director", x: anchor.x, y: anchor.y + 0.28, z: anchor.z, yield: true })
    }
    return anchors
  }, [seats, zones, rug, width, height])

  return (
    <group>
      {/* Soft fill plus the day/twilight/night key, so desks are not flat grey. */}
      <ambientLight color={lighting.keyLight} intensity={0.34} />
      <hemisphereLight
        args={[lighting.hemiSky, lighting.hemiGround, lighting.hemiIntensity * 0.72]}
        position={[0, 18, 0]}
      />
      <directionalLight
        color={lighting.keyLight}
        position={lighting.sunPosition}
        intensity={lighting.keyIntensity}
        castShadow
        shadow-mapSize={[1024, 1024]}
        shadow-bias={-0.0004}
        shadow-camera-near={2}
        shadow-camera-far={36}
        shadow-camera-left={-15}
        shadow-camera-right={15}
        shadow-camera-top={15}
        shadow-camera-bottom={-15}
      />

      {/* Lighter floor from the canvas token with a subtle grid */}
      <mesh position={[0, -0.02, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[floorW, floorD]} />
        <meshStandardMaterial color={palette.canvas} roughness={0.92} />
      </mesh>
      <gridHelper
        ref={gridRef}
        args={[gridSize, gridDivisions, palette.line, palette.line]}
        position={[0, -0.01, 0]}
      />

      {/* Low back and side walls */}
      <mesh position={[0, wallH / 2, -floorD / 2 + wallT / 2]} receiveShadow>
        <boxGeometry args={[floorW, wallH, wallT]} />
        <meshStandardMaterial color={palette.sidebar} roughness={0.85} />
        <Edges threshold={15} color={palette.line} />
      </mesh>
      <mesh position={[-floorW / 2 + wallT / 2, wallH * 0.45, 0]} receiveShadow>
        <boxGeometry args={[wallT, wallH * 0.9, floorD]} />
        <meshStandardMaterial color={palette.sidebar} roughness={0.85} />
        <Edges threshold={15} color={palette.line} />
      </mesh>
      <mesh position={[floorW / 2 - wallT / 2, wallH * 0.45, 0]} receiveShadow>
        <boxGeometry args={[wallT, wallH * 0.9, floorD]} />
        <meshStandardMaterial color={palette.sidebar} roughness={0.85} />
        <Edges threshold={15} color={palette.line} />
      </mesh>
      {/* Two simple windows and a baseboard so the room is not an empty box. */}
      {[-0.28, 0.28].map((side) => (
        <mesh key={side} position={[floorW * side, wallH * 0.62, -floorD / 2 + wallT + 0.02]}>
          <boxGeometry args={[Math.min(1.6, floorW * 0.18), 0.62, 0.04]} />
          <meshStandardMaterial
            color={lighting.windowGlow}
            emissive={lighting.windowGlow}
            emissiveIntensity={0.18}
            roughness={0.45}
          />
        </mesh>
      ))}
      <mesh position={[0, 0.04, -floorD / 2 + wallT + 0.01]}>
        <boxGeometry args={[floorW - wallT * 2, 0.08, 0.06]} />
        <meshStandardMaterial color={palette.deskBody} roughness={0.8} />
      </mesh>

      {/* Back wall task board with one sticky note per active run */}
      <TaskBoard3D notes={taskNotes} floorD={floorD} wallT={wallT} palette={palette} />

      {/* Side wall lane meter strip with one bar per lane in its health color */}
      <LaneMeterStrip3D bars={laneBars} floorW={floorW} wallT={wallT} palette={palette} />

      {/* Subtle team zones on the floor. Names sit low and hide when a desk label would cover them. */}
      {zones.map((zone, index) => {
        const zWorld = toWorld(zone, width, height)
        const zoneLabel = zoneLabelAnchor(zWorld)
        const tint = zoneTints[index % zoneTints.length] ?? palette.surface
        return (
          <group key={zone.id}>
            <mesh position={[zWorld.x, 0.005, zWorld.z]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
              <planeGeometry args={[zWorld.w, zWorld.d]} />
              <meshStandardMaterial color={tint} roughness={0.94} />
            </mesh>
            {zone.pods.map((pod) => {
              const pWorld = toWorld(pod, width, height)
              return (
                <mesh
                  key={`${pod.x}-${pod.y}`}
                  position={[pWorld.x, 0.009, pWorld.z]}
                  rotation={[-Math.PI / 2, 0, 0]}
                  receiveShadow
                >
                  <planeGeometry args={[pWorld.w * 0.96, pWorld.d * 0.96]} />
                  <meshStandardMaterial color={palette.surface} roughness={0.9} transparent opacity={0.55} />
                </mesh>
              )
            })}
            <FloorName
              id={`zone-${zone.id}`}
              position={[zoneLabel.x, zoneLabel.y + 0.28, zoneLabel.z]}
              placementsRef={placementsRef}
              testId={`zone3d-label-${zone.id}`}
              label={zone.label}
              className="cursor-pointer select-none whitespace-nowrap rounded-md bg-surface px-1.5 py-0.5 font-sans text-[11px] font-medium text-muted shadow-xs hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
              onClick={() => onFocusArea({ id: zone.id, label: zone.label, x: zone.x, y: zone.y, w: zone.w, h: zone.h })}
            />
          </group>
        )
      })}

      {/* Director rug */}
      {rug && (() => {
        const rWorld = toWorld(rug, width, height)
        const rugLabel = directorLabelAnchor(rWorld)
        return (
          <group>
            <mesh position={[rWorld.x, 0.008, rWorld.z]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
              <planeGeometry args={[rWorld.w, rWorld.d]} />
              <meshStandardMaterial color={palette.accentSoft} roughness={0.88} />
            </mesh>
            <FloorName
              id="zone-director"
              position={[rugLabel.x, rugLabel.y + 0.28, rugLabel.z]}
              placementsRef={placementsRef}
              testId="zone3d-label-director"
              label="Director"
              className="cursor-pointer select-none whitespace-nowrap rounded-md bg-surface px-1.5 py-0.5 font-sans text-[11px] font-medium text-accent shadow-xs hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
              onClick={() => onFocusArea({ id: "director", label: "Director", ...rug })}
            />
          </group>
        )
      })()}

      {/* Instanced static desk, monitor, and office chair geometry */}
      <InstancedDeskFurniture seats={seats} roomWidth={width} roomHeight={height} palette={palette} />

      {/* Characters seated at desks */}
      {seats.map((seat) => (
        <CharacterSeatGroup
          key={seat.desk.member.id}
          seat={seat}
          roomWidth={width}
          roomHeight={height}
          palette={palette}
          theme={theme}
          selected={selectedId === seat.desk.member.id}
          focused={focusedId === seat.desk.member.id}
          mentioned={mentionIds.has(seat.desk.member.id)}
          placementsRef={placementsRef}
          reducedMotion={reducedMotion}
          walkingOut={walkingIds.has(seat.desk.member.id)}
          mergeAnim={mergesByMember.get(seat.desk.member.id) ?? null}
          now={now}
          onSelect={onSelect}
          onOpenApproval={onOpenApproval}
        />
      ))}

      {/* Active handoff walkers carrying paper to target desk and back */}
      {handoffs.map((anim) => {
        const fromSeat = seatsByMember.get(anim.fromMemberId)
        const toSeat = seatsByMember.get(anim.toMemberId)
        if (!fromSeat || !toSeat) return null
        return (
          <WalkingHandoffActor3D
            key={anim.id}
            anim={anim}
            fromSeat={fromSeat}
            toSeat={toSeat}
            roomWidth={width}
            roomHeight={height}
            theme={theme}
            now={now}
            reducedMotion={reducedMotion}
          />
        )
      })}

      <NameLabelDriver anchors={labelAnchors} placementsRef={placementsRef} />
      <CameraRig
        overview={overviewPose}
        destination={destinationPose}
        moveToken={moveToken}
        orbitNonce={orbitNonce}
        reducedMotion={reducedMotion}
        orbitDeltaRef={orbitDeltaRef}
        onMovingChange={onCameraMovingChange}
      />
    </group>
  )
}

export interface Office3DSceneProps {
  desks: DeskInfo[]
  channels: Channel[]
  lanes?: readonly Lane[] | undefined
  runs?: readonly Run[] | undefined
  departments?: readonly Department[]
  events?: readonly StreamEvent[] | undefined
  now: number
  theme?: ThemeChoice
  reducedMotion?: boolean
  webglAvailable?: boolean
  initialSelectedId?: string
  onOpenApproval?: (desk: DeskInfo) => void
  onResolveApproval?: (approval: Approval, option: string, commitMessage?: string) => void | Promise<unknown>
  onMessage?: (member: Member) => void
}

export function Office3DScene({
  desks,
  channels,
  lanes: lanesProp,
  runs: runsProp,
  departments,
  events: eventsProp,
  now,
  theme = "light",
  reducedMotion = false,
  webglAvailable: webglProp,
  initialSelectedId,
  onOpenApproval,
  onResolveApproval,
  onMessage,
}: Office3DSceneProps) {
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId ?? null)
  const [focusedId, setFocusedId] = useState<string | null>(initialSelectedId ?? null)
  const [cameraTargetId, setCameraTargetId] = useState<string | null>(initialSelectedId ?? null)
  const [cameraArea, setCameraArea] = useState<RoomArea | null>(null)
  const [canvasAspect, setCanvasAspect] = useState(1.6)
  const [moveToken, setMoveToken] = useState(0)
  const [cameraMoving, setCameraMoving] = useState(false)
  const [legendOn, setLegendOn] = useState<LegendKey[]>([])
  const legendActive = useMemo(() => new Set(legendOn), [legendOn])
  const [orbitNonce, setOrbitNonce] = useState(0)
  const [streamQueue, setStreamQueue] = useState<OfficeAnimationQueue>(() => createAnimationQueue())
  const [liveMentions, setLiveMentions] = useState<MentionRecord[]>([])
  const orbitDeltaRef = useRef<OrbitDelta>({ yaw: 0, pitch: 0, radiusDelta: 0 })
  const pageVisible = useDocumentVisible()
  const surfaceRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)

  const members = useMemo(() => desks.map((d) => d.member), [desks])
  const runs = useMemo(
    () =>
      runsProp ??
      desks
        .map((d) => d.currentRun)
        .filter((r): r is Run => r !== null),
    [runsProp, desks],
  )
  const lanes = useMemo(() => {
    if (lanesProp && lanesProp.length > 0) return [...lanesProp]
    const seen = new Set<string>()
    const list: Lane[] = []
    for (const desk of desks) {
      if (desk.lane && !seen.has(desk.lane.id)) {
        seen.add(desk.lane.id)
        list.push(desk.lane)
      }
    }
    return list
  }, [lanesProp, desks])

  const latestContextRef = useRef({ members, runs, now })
  useEffect(() => {
    latestContextRef.current = { members, runs, now }
  }, [members, runs, now])

  useEffect(() => {
    return onStreamEvent((event) => {
      const ctx = latestContextRef.current
      const stamped = mentionRecordsFromEvent(event, ctx.members, Date.now())
      setStreamQueue((prev) => enqueueOfficeEvent(prev, event, { ...ctx, now: Date.now() }))
      if (stamped.length === 0) return
      setLiveMentions((prev) => {
        const cutoff = Date.now() - MENTION_PULSE_MS
        return [...prev.filter((item) => item.at > cutoff), ...stamped].slice(-80)
      })
    })
  }, [])

  const activeQueue = useMemo(() => {
    let q = pruneAnimationQueue(streamQueue, now)
    if (eventsProp) {
      for (const ev of eventsProp) {
        q = enqueueOfficeEvent(q, ev, { members, runs, now })
      }
    }
    return pruneAnimationQueue(q, now)
  }, [streamQueue, eventsProp, members, runs, now])

  const handoffs = useMemo(
    () => activeQueue.items.filter((item): item is HandoffAnimation => item.kind === "handoff"),
    [activeQueue],
  )
  const mergesByMember = useMemo(() => {
    const map = new Map<string, MergeAnimation>()
    for (const item of activeQueue.items) {
      if (item.kind === "merge") {
        map.set(item.memberId, item)
      }
    }
    return map
  }, [activeQueue])

  const selectedDesk = desks.find((desk) => desk.member.id === selectedId) ?? null
  const webglAvailable = useMemo(() => webglProp ?? isWebGLAvailable(), [webglProp])
  const room = useMemo(() => layoutRoom(desks, { departments }), [desks, departments])
  const overviewPose = useMemo(() => defaultCameraPose(room.width, room.height), [room.width, room.height])
  const areas = useMemo(() => roomAreas(room), [room])
  const destinationPose = useMemo(() => {
    if (cameraArea && !cameraTargetId) {
      return areaCameraPose(toWorld(cameraArea, room.width, room.height), overviewPose, canvasAspect)
    }
    if (!cameraTargetId) return overviewPose
    const seat = room.seats.find((item) => item.desk.member.id === cameraTargetId)
    if (!seat) return overviewPose
    const coords = seatWorldCoords(seat, room.width, room.height)
    return deskCameraPose({ x: coords.x, z: coords.z, facing: seat.facing, scale: coords.scale })
  }, [cameraTargetId, cameraArea, canvasAspect, overviewPose, room])
  const openingPose = useMemo(
    () => openingCameraPose(overviewPose, reducedMotion),
    [overviewPose, reducedMotion],
  )
  const palette = SCENE_PALETTES[theme]
  const lighting = useMemo(() => deriveTimeOfDayLighting(now, theme), [now, theme])
  const taskNotes = useMemo(() => deriveTaskBoardNotes(desks), [desks])
  const laneBars = useMemo(() => deriveLaneMeterBars(lanes, theme), [lanes, theme])
  const propMentions = useMemo(
    () => (eventsProp ? mentionRecordsFromEvents(eventsProp, members) : []),
    [eventsProp, members],
  )
  const mentionIds = useMemo(() => {
    const ids = new Set(activeMentionIds(propMentions, now))
    for (const id of activeMentionIds(liveMentions, now)) ids.add(id)
    return ids
  }, [propMentions, liveMentions, now])

  const hasWorkingScreens = desks.some((desk) => desk.state === "working")
  const hasMotion = desks.some((desk) => {
    const pose = deriveCharacterPose(desk, { reducedMotion })
    return pose.animated && pose.pose !== "idle"
  })
  const hasLife =
    !reducedMotion && (hasMotion || activeQueue.items.length > 0 || mentionIds.size > 0 || cameraMoving)
  const frameloop = !pageVisible ? "never" : hasLife ? "always" : "demand"
  const visibleSeats = useMemo(
    () => room.seats.filter((seat) => deskMatchesLegend(seat.desk, legendActive)),
    [room.seats, legendActive],
  )

  const focusDesk = (memberId: string) => {
    setFocusedId(memberId)
    setCameraTargetId(memberId)
    setCameraArea(null)
    setMoveToken((token) => token + 1)
  }

  const showOverview = () => {
    setFocusedId(null)
    setCameraTargetId(null)
    setCameraArea(null)
    setMoveToken((token) => token + 1)
  }

  // Glide to frame a zone or the Director rug with the camera rig's usual easing.
  const focusArea = (area: RoomArea) => {
    setFocusedId(null)
    setCameraTargetId(null)
    setCameraArea(area)
    const canvas = frameRef.current ?? surfaceRef.current
    if (canvas && canvas.clientWidth > 0 && canvas.clientHeight > 0) {
      setCanvasAspect(canvas.clientWidth / canvas.clientHeight)
    }
    setMoveToken((token) => token + 1)
  }

  // Close the side panel and give focus back to what opened it, else the 3D surface.
  const closePanel = () => {
    setSelectedId(null)
    const back = returnFocusRef.current
    returnFocusRef.current = null
    const target = back && back.isConnected ? back : surfaceRef.current
    target?.focus({ preventScroll: true })
  }

  useEffect(() => {
    if (!webglAvailable || desks.length === 0) {
      if (!selectedDesk) return
      function onEscape(event: KeyboardEvent) {
        if (event.key !== "Escape") return
        if (isTypingTarget(event.target)) return
        closePanel()
      }
      window.addEventListener("keydown", onEscape)
      return () => window.removeEventListener("keydown", onEscape)
    }

    function onKeyDown(event: KeyboardEvent) {
      if (isTypingTarget(event.target)) return
      const inPanel = event.target instanceof HTMLElement && Boolean(event.target.closest("aside"))
      if (inPanel && event.key !== "Escape") return
      if ((event.key === "Enter" || event.key === " ") && !inPanel && focusedId) {
        const onControl = event.target instanceof HTMLElement && Boolean(event.target.closest("button, a, [role=button]"))
        const seat = room.seats.find((item) => item.desk.member.id === focusedId)
        if (seat && !onControl && !event.metaKey && !event.ctrlKey && !event.altKey) {
          event.preventDefault()
          handleSelect(seat.desk)
          return
        }
      }
      const action = mapOfficeKey(event)
      if (!action) return
      if (action.type === "reset") {
        if (selectedDesk) closePanel()
        else setSelectedId(null)
        showOverview()
        return
      }
      if (inPanel) return
      if (action.type === "orbit") {
        event.preventDefault()
        orbitDeltaRef.current.yaw += action.yaw
        orbitDeltaRef.current.pitch += action.pitch
        setOrbitNonce((nonce) => nonce + 1)
        return
      }
      if (action.type === "zoom") {
        event.preventDefault()
        orbitDeltaRef.current.radiusDelta += action.radiusDelta
        setOrbitNonce((nonce) => nonce + 1)
        return
      }
      event.preventDefault()
      const index = visibleSeats.findIndex((seat) => seat.desk.member.id === focusedId)
      const next = cycleDeskIndex(visibleSeats.length, index, action.delta)
      const seat = visibleSeats[next]
      if (seat) focusDesk(seat.desk.member.id)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
    // handleSelect and closePanel only touch state setters and refs, so a stale copy is safe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [webglAvailable, desks.length, selectedDesk, visibleSeats, focusedId])

  function handleSelect(desk: DeskInfo) {
    const active = document.activeElement
    if (selectedId === null && active instanceof HTMLElement && active !== document.body) {
      returnFocusRef.current = active
    }
    setSelectedId(desk.member.id)
    focusDesk(desk.member.id)
  }

  function handleApproval(desk: DeskInfo) {
    setSelectedId(desk.member.id)
    focusDesk(desk.member.id)
    onOpenApproval?.(desk)
  }

  function handleResetView() {
    showOverview()
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 overflow-x-hidden">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 p-2 sm:p-4">
        <div className="flex flex-wrap items-center justify-between gap-2 text-[12px]">
          <div className="flex items-center gap-2">
            <span className="inline-block h-2 w-2 rounded-full bg-accent" aria-hidden="true" />
            <span className="font-medium text-ink">3D studio floor</span>
            <span className="tabular-nums text-faint">{desks.length} desks</span>
            <span
              data-testid="office3d-day-period"
              data-period={lighting.period}
              className="rounded-md bg-sidebar px-1.5 py-0.5 text-[11px] text-muted"
            >
              {lighting.period}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] text-muted max-sm:sr-only">
              Arrows orbit, +/- zoom, Tab cycles desks, click a desk for details
            </span>
            <button
              type="button"
              data-testid="office3d-reset-view"
              onClick={handleResetView}
              className="min-h-7 rounded-md border border-line bg-surface px-2.5 py-0.5 text-[11px] font-medium text-ink shadow-xs hover:bg-sidebar"
            >
              Reset view
            </button>
          </div>
        </div>

        {/* Wall summary strip for task board notes, lane meter bars, and active event animations */}
        {(taskNotes.length > 0 || laneBars.length > 0 || handoffs.length > 0) && (
          <div className="flex flex-wrap items-center gap-2 text-[12px]">
            {taskNotes.length > 0 && (
              <div
                data-testid="office3d-task-board"
                aria-label="Back wall task board"
                className="flex min-w-0 flex-wrap items-center gap-1.5 rounded-lg border border-line bg-surface px-2 py-1"
              >
                <span className="text-[11px] font-medium text-faint">Tasks</span>
                {taskNotes.map((note) => (
                  <span
                    key={note.id}
                    data-testid={`task-note3d-${note.id}`}
                    data-hue={note.hue}
                    title={`@${note.handle}: ${note.title}`}
                    className="inline-flex max-w-52 items-center gap-1.5 text-ink"
                  >
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: note.accent }} aria-hidden="true" />
                    <span className="truncate">@{note.handle} {note.title}</span>
                  </span>
                ))}
              </div>
            )}
            {laneBars.length > 0 && (
              <div
                data-testid="office3d-lane-strip"
                aria-label="Side wall lane meter"
                className="flex min-w-0 flex-wrap items-center gap-1.5 rounded-lg border border-line bg-surface px-2 py-1"
              >
                <span className="text-[11px] font-medium text-faint">Lanes</span>
                {laneBars.map((bar) => (
                  <span
                    key={bar.id}
                    data-testid={`lane-bar3d-${bar.id}`}
                    data-health={bar.health}
                    title={`${bar.id} (${bar.health})`}
                    className="inline-flex max-w-40 items-center gap-1.5 text-muted"
                  >
                    <span
                      style={{ backgroundColor: bar.color }}
                      className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                      aria-hidden="true"
                    />
                    <span className="truncate">{bar.id}</span>
                  </span>
                ))}
              </div>
            )}
            {handoffs.map((anim) => (
              <span
                key={anim.id}
                data-testid={`handoff-walk3d-${anim.id}`}
                className="inline-flex items-center gap-1.5 rounded-md bg-accent-soft px-2 py-1 text-[12px] text-accent"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden="true" />
                @{anim.fromHandle} -&gt; @{anim.toHandle}
              </span>
            ))}
          </div>
        )}

        {desks.length === 0 ? (
          <p className="py-12 text-center text-[13px] text-muted">No workspace members yet.</p>
        ) : !webglAvailable ? (
          <div
            data-testid="office3d-fallback"
            role="status"
            className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 rounded-2xl border border-line bg-canvas p-6 text-center"
          >
            <p className="text-[14px] font-medium text-ink">
              3D view is unavailable because WebGL could not be initialized on this device.
            </p>
            <p className="max-w-md text-[12px] text-muted">
              Switch to the 2D floor plan, or select a desk below to inspect its lane, health, and active run.
            </p>
            {room.zones.length > 0 && (
              <div className="flex flex-wrap justify-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-faint">
                {room.zones.map((zone) => (
                  <span key={zone.id} data-testid={`fallback-zone-${zone.id}`}>
                    {zone.label}
                  </span>
                ))}
              </div>
            )}
            <div className="mt-1 flex flex-wrap justify-center gap-2">
              {visibleSeats.map((seat) => {
                const identity = deriveCharacterIdentity(seat.desk, theme)
                const pose = deriveCharacterPose(seat.desk, { reducedMotion })
                const mergeAnim = mergesByMember.get(seat.desk.member.id)
                return (
                  <div key={seat.desk.member.id} className="inline-flex items-center gap-1">
                    <button
                      type="button"
                      data-testid={`fallback-desk-${seat.desk.member.id}`}
                      data-pose={pose.pose}
                      data-cli={identity.cli}
                      data-role-pin={identity.rolePin ?? undefined}
                      data-quota-note={pose.quotaNote ?? undefined}
                      onClick={() => handleSelect(seat.desk)}
                      className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 py-1 text-[12px] text-ink hover:bg-sidebar"
                    >
                      <AgentAvatar
                        member={seat.desk.member}
                        size={20}
                        state={avatarState(seat.desk.state)}
                        decorative
                      />
                      <span>{seat.desk.member.display_name || seat.desk.member.handle}</span>
                      {pose.quotaNote && (
                        <span
                          data-testid={`quota-note3d-${seat.desk.member.id}`}
                          className="font-mono text-[10px] text-danger"
                        >
                          ({pose.quotaNote})
                        </span>
                      )}
                      {mergeAnim && (
                        <span
                          data-testid={`merge-check3d-${seat.desk.member.id}`}
                          className="font-mono text-[11px] font-bold text-ok"
                        >
                          merged
                        </span>
                      )}
                    </button>
                    {pose.showApprovalCard && (
                      <button
                        type="button"
                        data-testid={`approval-card3d-${seat.desk.member.id}`}
                        onClick={() => handleApproval(seat.desk)}
                        className="min-h-8 rounded-md border border-warn bg-warn-soft px-2 py-1 text-[11px] font-medium text-warn hover:bg-surface"
                      >
                        Approval waiting
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        ) : (
          <div
            data-testid="office3d-canvas"
            data-render={frameloop}
            ref={surfaceRef}
            tabIndex={0}
            aria-label="3D office. Tab cycles desks, Enter opens details."
            className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-line bg-canvas shadow-xs"
          >
            <div ref={frameRef} className="relative min-h-0 flex-1">
            <Canvas
              shadows="soft"
              dpr={[1, OFFICE_MAX_DPR]}
              frameloop={frameloop}
              camera={{ position: openingPose.position, fov: 38, near: 0.5, far: 120 }}
              gl={{ antialias: true, powerPreference: "low-power", stencil: false }}
              onCreated={({ gl }) => {
                gl.setPixelRatio(Math.min(window.devicePixelRatio || 1, OFFICE_MAX_DPR))
              }}
            >
              <color attach="background" args={[palette.canvas]} />
              <CodeScreenDriver scrolling={hasWorkingScreens && !reducedMotion && pageVisible}>
                <RoomWorld
                  width={room.width}
                  height={room.height}
                  zones={room.zones}
                  rug={room.rug}
                  seats={visibleSeats}
                  palette={palette}
                  theme={theme}
                  lighting={lighting}
                  taskNotes={taskNotes}
                  laneBars={laneBars}
                  handoffs={handoffs}
                  mergesByMember={mergesByMember}
                  now={now}
                  selectedId={selectedDesk?.member.id ?? null}
                  focusedId={focusedId}
                  mentionIds={mentionIds}
                  reducedMotion={reducedMotion}
                  overviewPose={overviewPose}
                  destinationPose={destinationPose}
                  moveToken={moveToken}
                  orbitNonce={orbitNonce}
                  orbitDeltaRef={orbitDeltaRef}
                  onCameraMovingChange={setCameraMoving}
                  onSelect={handleSelect}
                  onOpenApproval={handleApproval}
                  onFocusArea={focusArea}
                />
              </CodeScreenDriver>
            </Canvas>
            </div>
            <div className="max-sm:flex max-sm:flex-col max-sm:gap-1.5 max-sm:border-t max-sm:border-line max-sm:bg-surface max-sm:p-2 sm:contents">
              <Legend
                active={legendActive}
                onToggle={(key) => setLegendOn((current) => toggleLegendKey(current, key))}
                className="max-sm:static max-sm:max-w-none"
              />
              <ZoomControls
                areas={areas}
                onFit={showOverview}
                onJump={focusArea}
                className="max-sm:static max-sm:max-w-none max-sm:self-end"
              />
            </div>
          </div>
        )}
      </div>

      {selectedDesk && (
        <DeskDetailPanel
          desk={selectedDesk}
          channels={channels}
          now={now}
          reducedMotion={reducedMotion}
          onClose={closePanel}
          onOpenApproval={onOpenApproval}
          onResolveApproval={onResolveApproval}
          onMessage={onMessage}
        />
      )}
    </div>
  )
}

export function Office3DPage() {
  const { desks, channels, lanes, runs, departments, isPending, now, theme } = useOfficeDesks()
  const reducedMotion = useReducedMotion()
  const openDirect = useOpenDirect()
  const qc = useQueryClient()
  const [navOpen, setNavOpen] = useState(false)

  async function handleResolveApproval(approval: Approval, option: string, commitMessage?: string) {
    const body = commitMessage ? { option, commit_message: commitMessage } : { option }
    const next = await api.resolveApproval(approval.id, body)
    qc.setQueryData<Approval[]>(qk.approvals, (list = []) => replaceById(list, next))
  }

  function handleMessage(member: Member) {
    void openDirect(member)
  }

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b border-line px-3 py-2">
        <Dialog.Root open={navOpen} onOpenChange={setNavOpen}>
          <Dialog.Trigger className="min-h-8 rounded border border-line px-2 text-[12px] md:hidden">
            Channels
          </Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/40" />
            <Dialog.Content className="fixed inset-y-0 left-0 z-50 flex w-72 flex-col bg-sidebar p-2 shadow-lg">
              <Dialog.Title className="px-2 pt-2 text-[13px] font-medium">Channels</Dialog.Title>
              <WorkspaceNav onNavigate={() => setNavOpen(false)} />
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
        <h1 className="text-[15px] font-semibold">Office</h1>
        <p className="text-[12px] tabular-nums text-muted">{desks.length} desks</p>
        <OfficeViewToggle mode="3d" />
      </header>
      {isPending ? (
        <p className="p-4 text-[13px] text-muted">Loading office</p>
      ) : (
        <Office3DScene
          desks={desks}
          channels={channels}
          lanes={lanes}
          runs={runs}
          departments={departments}
          now={now}
          theme={theme}
          reducedMotion={reducedMotion}
          onResolveApproval={handleResolveApproval}
          onMessage={handleMessage}
        />
      )}
    </section>
  )
}

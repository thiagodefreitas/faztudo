import * as Dialog from "@radix-ui/react-dialog"
import { Billboard, Html, OrbitControls } from "@react-three/drei"
import { Canvas, useFrame } from "@react-three/fiber"
import { useQueryClient } from "@tanstack/react-query"
import { useEffect, useMemo, useRef, useState } from "react"
import type { Group, MeshStandardMaterial } from "three"
import { api } from "../../../api/client"
import type { ThemeChoice } from "../../../lib/theme"
import { useOpenDirect } from "../../../state/direct"
import { qk } from "../../../state/keys"
import { replaceById } from "../../../state/merge"
import type { Approval, Channel, Department, Member } from "../../../types"
import { AgentAvatar } from "../../agent-avatar"
import { WorkspaceNav } from "../../sidebar"
import { avatarState } from "../avatar"
import { DESK_H, DESK_W, layoutRoom, type PlacedZone, type Rect, type Seat } from "../layout"
import { DeskDetailPanel, Legend, OfficeViewToggle } from "../scene"
import { type DeskInfo, useOfficeDesks, useReducedMotion } from "../state"

// Convert 2D SVG layout units (1200 wide) into compact 3D world meters.
const SCALE_3D = 0.02

interface ScenePalette {
  canvas: string
  surface: string
  sidebar: string
  line: string
  ink: string
  accent: string
  accentSoft: string
  warn: string
  danger: string
  code: string
}

const SCENE_PALETTES: Record<ThemeChoice, ScenePalette> = {
  light: {
    canvas: "#f7f9fa",
    surface: "#ffffff",
    sidebar: "#eef2f5",
    line: "#dfe6eb",
    ink: "#11181c",
    accent: "#0e7c74",
    accentSoft: "#dff3f0",
    warn: "#8a4b08",
    danger: "#b42318",
    code: "#eef2f5",
  },
  dark: {
    canvas: "#0f1417",
    surface: "#151c21",
    sidebar: "#0b0f12",
    line: "#222c33",
    ink: "#edf2f4",
    accent: "#5cd6c8",
    accentSoft: "#102a29",
    warn: "#f5b942",
    danger: "#f97066",
    code: "#0b0f12",
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

function toWorld(rect: Rect, roomWidth: number, roomHeight: number): { x: number; z: number; w: number; d: number } {
  const w = rect.w * SCALE_3D
  const d = rect.h * SCALE_3D
  const x = (rect.x + rect.w / 2 - roomWidth / 2) * SCALE_3D
  const z = (rect.y + rect.h / 2 - roomHeight / 2) * SCALE_3D
  return { x, z, w, d }
}

function DeskMesh({
  seat,
  roomWidth,
  roomHeight,
  palette,
  selected,
  reducedMotion,
  onSelect,
}: {
  seat: Seat
  roomWidth: number
  roomHeight: number
  palette: ScenePalette
  selected: boolean
  reducedMotion: boolean
  onSelect: (desk: DeskInfo) => void
}) {
  const { desk, scale, facing = "down" } = seat
  const { member, state, outOfQuota, palette: hue } = desk
  const dimmed = state === "out_of_quota" || outOfQuota
  const working = state === "working"
  const faceUp = facing === "up"

  const world = toWorld(
    { x: seat.x, y: seat.y, w: DESK_W * scale, h: DESK_H * scale },
    roomWidth,
    roomHeight,
  )

  const agentGroupRef = useRef<Group>(null)
  const screenMatRef = useRef<MeshStandardMaterial>(null)

  useFrame(({ clock }) => {
    if (reducedMotion) return
    const t = clock.getElapsedTime()
    if (agentGroupRef.current) {
      if (working) {
        agentGroupRef.current.position.y = Math.sin(t * 4) * 0.035
        agentGroupRef.current.rotation.y = 0
      } else if (state === "idle" && !dimmed) {
        agentGroupRef.current.position.y = 0
        agentGroupRef.current.rotation.y = Math.sin(t * 0.9 + seat.x * 0.05) * 0.18
      } else {
        agentGroupRef.current.position.y = 0
        agentGroupRef.current.rotation.y = 0
      }
    }
    if (screenMatRef.current && working) {
      screenMatRef.current.emissiveIntensity = 0.55 + Math.sin(t * 3.2) * 0.25
    }
  })

  const monitorColor =
    state === "working"
      ? hue.accent
      : state === "waiting_approval"
        ? palette.warn
        : state === "failed"
          ? palette.danger
          : palette.code
  const monitorEmissive =
    state === "working"
      ? hue.accent
      : state === "waiting_approval"
        ? palette.warn
        : state === "failed"
          ? palette.danger
          : "#000000"
  const monitorIntensity = state === "working" ? 0.65 : state === "waiting_approval" || state === "failed" ? 0.35 : 0

  const deskW = 1.65 * scale
  const deskD = 0.9 * scale
  const deskH = 0.42 * scale
  const zSign = faceUp ? -1 : 1
  const deskOffsetZ = 0.14 * scale * zSign
  const agentOffsetZ = -0.46 * scale * zSign

  return (
    <group
      position={[world.x, 0, world.z]}
      onClick={(event) => {
        event.stopPropagation()
        onSelect(desk)
      }}
    >
      {/* Selection ring on the floor */}
      {selected && (
        <mesh position={[0, 0.015, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[deskW + 0.5, deskD + 0.95]} />
          <meshBasicMaterial color={palette.accent} transparent opacity={0.28} />
        </mesh>
      )}

      {/* Low-poly desk box */}
      <mesh position={[0, deskH / 2, deskOffsetZ]}>
        <boxGeometry args={[deskW, deskH, deskD]} />
        <meshStandardMaterial
          color={palette.surface}
          roughness={0.85}
          transparent={dimmed}
          opacity={dimmed ? 0.5 : 1}
        />
      </mesh>

      {/* Hue accent strip along the desk top */}
      <mesh position={[0, deskH + 0.01, deskOffsetZ - 0.32 * scale * zSign]}>
        <boxGeometry args={[deskW * 0.78, 0.025, 0.06]} />
        <meshBasicMaterial color={hue.accent} />
      </mesh>

      {/* Monitor stand and screen */}
      <mesh position={[0, deskH + 0.06 * scale, deskOffsetZ]}>
        <boxGeometry args={[0.14 * scale, 0.12 * scale, 0.1 * scale]} />
        <meshStandardMaterial color={palette.line} roughness={0.8} />
      </mesh>
      <mesh position={[0, deskH + 0.24 * scale, deskOffsetZ]}>
        <boxGeometry args={[0.62 * scale, 0.34 * scale, 0.06 * scale]} />
        <meshStandardMaterial
          ref={screenMatRef}
          color={monitorColor}
          emissive={monitorEmissive}
          emissiveIntensity={monitorIntensity}
          roughness={0.4}
        />
      </mesh>

      {/* Agent rounded capsule + billboarded AgentAvatar */}
      <group ref={agentGroupRef} position={[0, 0, agentOffsetZ]}>
        <mesh position={[0, 0.38 * scale, 0]}>
          <capsuleGeometry args={[0.22 * scale, 0.32 * scale, 4, 8]} />
          <meshStandardMaterial
            color={desk.isDirector ? palette.accent : hue.accent}
            roughness={0.6}
            transparent={dimmed}
            opacity={dimmed ? 0.45 : 1}
          />
        </mesh>

        <Billboard position={[0, 1.08 * scale, 0]}>
          <Html center transform={false} zIndexRange={[10, 0]}>
            <button
              type="button"
              data-testid={`desk3d-${member.id}`}
              aria-label={`${member.display_name}, ${desk.stateLabel}`}
              onClick={(event) => {
                event.stopPropagation()
                onSelect(desk)
              }}
              className="group flex flex-col items-center gap-0.5 rounded-lg px-1.5 py-0.5 text-center outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <AgentAvatar member={member} size={28} state={avatarState(state)} decorative />
              <span className="max-w-24 truncate rounded bg-surface/90 px-1.5 py-0.2 font-sans text-[10px] font-semibold text-ink shadow-xs">
                {member.display_name}
              </span>
            </button>
          </Html>
        </Billboard>
      </group>
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
  selectedId,
  reducedMotion,
  onSelect,
}: {
  width: number
  height: number
  zones: PlacedZone[]
  rug: Rect | null
  seats: Seat[]
  palette: ScenePalette
  selectedId: string | null
  reducedMotion: boolean
  onSelect: (desk: DeskInfo) => void
}) {
  const floorW = width * SCALE_3D
  const floorD = height * SCALE_3D
  const wallH = 1.15
  const wallT = 0.22

  return (
    <group>
      <ambientLight intensity={0.85} />
      <directionalLight position={[8, 16, 10]} intensity={0.95} />

      {/* Floor */}
      <mesh position={[0, -0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[floorW, floorD]} />
        <meshStandardMaterial color={palette.canvas} roughness={0.95} />
      </mesh>

      {/* Low back and side walls */}
      <mesh position={[0, wallH / 2, -floorD / 2 + wallT / 2]}>
        <boxGeometry args={[floorW, wallH, wallT]} />
        <meshStandardMaterial color={palette.sidebar} roughness={0.9} />
      </mesh>
      <mesh position={[-floorW / 2 + wallT / 2, wallH * 0.35, 0]}>
        <boxGeometry args={[wallT, wallH * 0.7, floorD]} />
        <meshStandardMaterial color={palette.sidebar} roughness={0.9} />
      </mesh>
      <mesh position={[floorW / 2 - wallT / 2, wallH * 0.35, 0]}>
        <boxGeometry args={[wallT, wallH * 0.7, floorD]} />
        <meshStandardMaterial color={palette.sidebar} roughness={0.9} />
      </mesh>

      {/* Zone mats */}
      {zones.map((zone) => {
        const zWorld = toWorld(zone, width, height)
        return (
          <group key={zone.id}>
            <mesh position={[zWorld.x, 0.005, zWorld.z]} rotation={[-Math.PI / 2, 0, 0]}>
              <planeGeometry args={[zWorld.w, zWorld.d]} />
              <meshStandardMaterial color={palette.surface} roughness={0.95} />
            </mesh>
          </group>
        )
      })}

      {/* Director rug */}
      {rug && (() => {
        const rWorld = toWorld(rug, width, height)
        return (
          <mesh position={[rWorld.x, 0.008, rWorld.z]} rotation={[-Math.PI / 2, 0, 0]}>
            <planeGeometry args={[rWorld.w, rWorld.d]} />
            <meshStandardMaterial color={palette.accentSoft} roughness={0.9} />
          </mesh>
        )
      })()}

      {/* Desks and agents */}
      {seats.map((seat) => (
        <DeskMesh
          key={seat.desk.member.id}
          seat={seat}
          roomWidth={width}
          roomHeight={height}
          palette={palette}
          selected={selectedId === seat.desk.member.id}
          reducedMotion={reducedMotion}
          onSelect={onSelect}
        />
      ))}

      <OrbitControls
        enablePan
        enableZoom
        enableRotate
        enableDamping={!reducedMotion}
        minPolarAngle={Math.PI / 7}
        maxPolarAngle={Math.PI / 2.25}
        minDistance={6}
        maxDistance={28}
      />
    </group>
  )
}

export interface Office3DSceneProps {
  desks: DeskInfo[]
  channels: Channel[]
  departments?: readonly Department[]
  now: number
  theme?: ThemeChoice
  reducedMotion?: boolean
  webglAvailable?: boolean
  initialSelectedId?: string
  onResolveApproval?: (approval: Approval, option: string, commitMessage?: string) => void | Promise<unknown>
  onMessage?: (member: Member) => void
}

export function Office3DScene({
  desks,
  channels,
  departments,
  now,
  theme = "light",
  reducedMotion = false,
  webglAvailable: webglProp,
  initialSelectedId,
  onResolveApproval,
  onMessage,
}: Office3DSceneProps) {
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId ?? null)
  const selectedDesk = desks.find((desk) => desk.member.id === selectedId) ?? null
  const webglAvailable = useMemo(() => webglProp ?? isWebGLAvailable(), [webglProp])
  const room = useMemo(() => layoutRoom(desks, { departments }), [desks, departments])
  const palette = SCENE_PALETTES[theme]
  const workingCount = desks.filter((desk) => desk.state === "working").length
  const frameloop = reducedMotion || workingCount === 0 ? "demand" : "always"

  useEffect(() => {
    if (!selectedDesk) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return
      const target = event.target
      if (target instanceof HTMLElement && target.closest("input, textarea, select")) return
      setSelectedId(null)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [selectedDesk])

  function handleSelect(desk: DeskInfo) {
    setSelectedId((prev) => (prev === desk.member.id ? prev : desk.member.id))
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 overflow-x-hidden">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 p-2 sm:p-4">
        <div className="flex flex-wrap items-center justify-between gap-2 text-[12px]">
          <div className="flex items-center gap-2">
            <span className="inline-block h-2 w-2 rounded-full bg-accent" aria-hidden="true" />
            <span className="font-medium text-ink">3D studio floor</span>
            <span className="font-mono text-faint">{desks.length} desks</span>
          </div>
          <span className="text-[11px] text-muted">Drag to orbit, scroll to zoom, click a desk for details</span>
        </div>

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
            <div className="mt-2 flex flex-wrap justify-center gap-2">
              {room.seats.map((seat) => (
                <button
                  key={seat.desk.member.id}
                  type="button"
                  data-testid={`fallback-desk-${seat.desk.member.id}`}
                  onClick={() => handleSelect(seat.desk)}
                  className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 py-1 text-[12px] text-ink hover:bg-sidebar"
                >
                  <AgentAvatar
                    member={seat.desk.member}
                    size={20}
                    state={avatarState(seat.desk.state)}
                    decorative
                  />
                  <span>{seat.desk.member.display_name}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div
            data-testid="office3d-canvas"
            className="relative min-h-0 flex-1 overflow-hidden rounded-2xl border border-line bg-canvas shadow-xs"
          >
            <Canvas
              dpr={[1, 1.5]}
              frameloop={frameloop}
              camera={{ position: [0, 12, 14], fov: 42, near: 0.5, far: 80 }}
              gl={{ antialias: true, powerPreference: "low-power" }}
            >
              <RoomWorld
                width={room.width}
                height={room.height}
                zones={room.zones}
                rug={room.rug}
                seats={room.seats}
                palette={palette}
                selectedId={selectedDesk?.member.id ?? null}
                reducedMotion={reducedMotion}
                onSelect={handleSelect}
              />
            </Canvas>
            <Legend />
          </div>
        )}
      </div>

      {selectedDesk && (
        <DeskDetailPanel
          desk={selectedDesk}
          channels={channels}
          now={now}
          reducedMotion={reducedMotion}
          onClose={() => setSelectedId(null)}
          onResolveApproval={onResolveApproval}
          onMessage={onMessage}
        />
      )}
    </div>
  )
}

export function Office3DPage() {
  const { desks, channels, departments, isPending, now, theme } = useOfficeDesks()
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
        <p className="font-mono text-[12px] text-muted">{desks.length} desks</p>
        <OfficeViewToggle mode="3d" />
      </header>
      {isPending ? (
        <p className="p-4 text-[13px] text-muted">Loading office</p>
      ) : (
        <Office3DScene
          desks={desks}
          channels={channels}
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

import { Billboard, Edges, Html } from "@react-three/drei"
import { useFrame } from "@react-three/fiber"
import { useContext, useLayoutEffect, useMemo, useRef, type RefObject } from "react"
import { Color, type Group, type InstancedMesh, type Mesh, type MeshBasicMaterial, type MeshStandardMaterial, Object3D } from "three"
import { cx } from "../../../lib/cx"
import type { Seat } from "../layout"
import type { DeskInfo, DeskState } from "../state"
import {
  type HandoffAnimation,
  type MergeAnimation,
  sampleHandoffWalk,
  sampleMergePop,
} from "./animations"
import { CodeScreenContext } from "./code-screen"
import { monitorScreenYaw, seatWorldCoords } from "./coords"
import type { NameLabelPlacement } from "./labels"
import {
  type CharacterIdentity,
  type CharacterPose,
  deriveCharacterIdentity,
  deriveCharacterPose,
  type LaneMeterBar,
  type PinMotif,
  sampleCharacterFrame,
  type TaskBoardNote,
} from "./poses"
import type { ScenePalette } from "./scene3d"
import { LabelPlacement } from "./view-rig"

export { seatWorldCoords } from "./coords"

function seedFromId(id: string): number {
  let hash = 0
  for (let i = 0; i < id.length; i += 1) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0
  }
  return hash
}

function statusDotClass(state: DeskState, outOfQuota: boolean): string {
  if (outOfQuota || state === "out_of_quota") return "bg-faint"
  if (state === "failed") return "bg-danger"
  if (state === "waiting_approval") return "bg-warn"
  if (state === "working") return "bg-accent"
  return "bg-line"
}

// Instanced static geometry for all desks, monitors, and office chairs so 15+
// seats render in a handful of draw calls on integrated GPUs.
export function InstancedDeskFurniture({
  seats,
  roomWidth,
  roomHeight,
  palette,
}: {
  seats: Seat[]
  roomWidth: number
  roomHeight: number
  palette: ScenePalette
}) {
  const count = seats.length
  const deskBaseRef = useRef<InstancedMesh>(null)
  const deskTopRef = useRef<InstancedMesh>(null)
  const standRef = useRef<InstancedMesh>(null)
  const bezelRef = useRef<InstancedMesh>(null)
  const chairSeatRef = useRef<InstancedMesh>(null)
  const chairBackRef = useRef<InstancedMesh>(null)
  const chairStemRef = useRef<InstancedMesh>(null)

  const dummy = useMemo(() => new Object3D(), [])
  const colors = useMemo(
    () => ({
      top: new Color(palette.deskTop),
      body: new Color(palette.deskBody),
      chair: new Color(palette.chair),
      director: new Color(palette.directorTop),
      line: new Color(palette.line),
    }),
    [palette],
  )

  useLayoutEffect(() => {
    if (count === 0) return
    seats.forEach((seat, i) => {
      const { x, z, scale, zSign, deskOffsetZ, chairOffsetZ } = seatWorldCoords(seat, roomWidth, roomHeight)
      const deskW = 1.68 * scale
      const deskD = 0.9 * scale
      const baseH = 0.36 * scale
      const topH = 0.06 * scale
      const deskH = baseH + topH

      if (deskBaseRef.current) {
        dummy.position.set(x, baseH / 2, z + deskOffsetZ)
        dummy.rotation.set(0, 0, 0)
        dummy.scale.set(deskW * 0.92, baseH, deskD * 0.88)
        dummy.updateMatrix()
        deskBaseRef.current.setMatrixAt(i, dummy.matrix)
        deskBaseRef.current.setColorAt(i, colors.body)
      }

      if (deskTopRef.current) {
        dummy.position.set(x, baseH + topH / 2, z + deskOffsetZ)
        dummy.rotation.set(0, 0, 0)
        dummy.scale.set(deskW, topH, deskD)
        dummy.updateMatrix()
        deskTopRef.current.setMatrixAt(i, dummy.matrix)
        deskTopRef.current.setColorAt(i, seat.desk.isDirector ? colors.director : colors.top)
      }

      if (standRef.current) {
        dummy.position.set(x, deskH + 0.06 * scale, z + deskOffsetZ)
        dummy.rotation.set(0, 0, 0)
        dummy.scale.set(0.14 * scale, 0.12 * scale, 0.1 * scale)
        dummy.updateMatrix()
        standRef.current.setMatrixAt(i, dummy.matrix)
      }

      if (bezelRef.current) {
        dummy.position.set(x, deskH + 0.25 * scale, z + deskOffsetZ)
        dummy.rotation.set(0, 0, 0)
        dummy.scale.set(0.66 * scale, 0.38 * scale, 0.06 * scale)
        dummy.updateMatrix()
        bezelRef.current.setMatrixAt(i, dummy.matrix)
      }

      if (chairStemRef.current) {
        dummy.position.set(x, 0.14 * scale, z + chairOffsetZ)
        dummy.rotation.set(0, 0, 0)
        dummy.scale.set(0.18 * scale, 0.28 * scale, 0.18 * scale)
        dummy.updateMatrix()
        chairStemRef.current.setMatrixAt(i, dummy.matrix)
        chairStemRef.current.setColorAt(i, colors.line)
      }

      if (chairSeatRef.current) {
        dummy.position.set(x, 0.29 * scale, z + chairOffsetZ)
        dummy.rotation.set(0, 0, 0)
        dummy.scale.set(0.46 * scale, 0.06 * scale, 0.44 * scale)
        dummy.updateMatrix()
        chairSeatRef.current.setMatrixAt(i, dummy.matrix)
        chairSeatRef.current.setColorAt(i, colors.chair)
      }

      if (chairBackRef.current) {
        dummy.position.set(x, 0.52 * scale, z + chairOffsetZ - 0.19 * scale * zSign)
        dummy.rotation.set(0, 0, 0)
        dummy.scale.set(0.44 * scale, 0.42 * scale, 0.06 * scale)
        dummy.updateMatrix()
        chairBackRef.current.setMatrixAt(i, dummy.matrix)
        chairBackRef.current.setColorAt(i, seat.desk.isDirector ? colors.director : colors.chair)
      }
    })

    for (const ref of [deskBaseRef, deskTopRef, standRef, bezelRef, chairStemRef, chairSeatRef, chairBackRef]) {
      if (ref.current) {
        ref.current.instanceMatrix.needsUpdate = true
        if (ref.current.instanceColor) ref.current.instanceColor.needsUpdate = true
      }
    }
  }, [seats, count, roomWidth, roomHeight, dummy, colors])

  if (count === 0) return null

  return (
    <group>
      <instancedMesh ref={deskBaseRef} args={[undefined, undefined, count]} castShadow receiveShadow>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color="#ffffff" roughness={0.84} />
      </instancedMesh>
      <instancedMesh ref={deskTopRef} args={[undefined, undefined, count]} castShadow receiveShadow>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color="#ffffff" roughness={0.72} />
      </instancedMesh>
      <instancedMesh ref={standRef} args={[undefined, undefined, count]} castShadow>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color={palette.deskBody} roughness={0.75} />
      </instancedMesh>
      <instancedMesh ref={bezelRef} args={[undefined, undefined, count]} castShadow>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color={palette.deskBody} roughness={0.62} />
      </instancedMesh>
      <instancedMesh ref={chairStemRef} args={[undefined, undefined, count]} castShadow>
        <cylinderGeometry args={[0.45, 0.7, 1, 8]} />
        <meshStandardMaterial color="#ffffff" roughness={0.7} />
      </instancedMesh>
      <instancedMesh ref={chairSeatRef} args={[undefined, undefined, count]} castShadow receiveShadow>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color="#ffffff" roughness={0.78} />
      </instancedMesh>
      <instancedMesh ref={chairBackRef} args={[undefined, undefined, count]} castShadow>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color="#ffffff" roughness={0.78} />
      </instancedMesh>
    </group>
  )
}

function RolePinMesh({
  motif,
  mainColor,
  softColor,
  zSign,
}: {
  motif: PinMotif
  mainColor: string
  softColor: string
  zSign: number
}) {
  return (
    <group position={[0.09, 0.05, 0.145 * zSign]} rotation={[0, zSign < 0 ? Math.PI : 0, 0]}>
      {/* Small pin backing disc */}
      <mesh rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.055, 0.055, 0.012, 12]} />
        <meshStandardMaterial color={softColor} roughness={0.4} />
      </mesh>
      {/* Role motif geometry on the pin */}
      {motif === "</>" && (
        <group position={[0, 0, 0.008]}>
          <mesh position={[-0.022, 0, 0]} rotation={[0, 0, Math.PI / 4]}>
            <boxGeometry args={[0.012, 0.032, 0.008]} />
            <meshBasicMaterial color={mainColor} />
          </mesh>
          <mesh position={[0, 0, 0]} rotation={[0, 0, -0.35]}>
            <boxGeometry args={[0.01, 0.042, 0.008]} />
            <meshBasicMaterial color={mainColor} />
          </mesh>
          <mesh position={[0.022, 0, 0]} rotation={[0, 0, -Math.PI / 4]}>
            <boxGeometry args={[0.012, 0.032, 0.008]} />
            <meshBasicMaterial color={mainColor} />
          </mesh>
        </group>
      )}
      {motif === "magnifier" && (
        <group position={[0, 0, 0.008]}>
          <mesh position={[-0.008, 0.008, 0]}>
            <torusGeometry args={[0.018, 0.005, 6, 12]} />
            <meshBasicMaterial color={mainColor} />
          </mesh>
          <mesh position={[0.014, -0.014, 0]} rotation={[0, 0, -Math.PI / 4]}>
            <boxGeometry args={[0.008, 0.024, 0.008]} />
            <meshBasicMaterial color={mainColor} />
          </mesh>
        </group>
      )}
      {motif === "compass" && (
        <group position={[0, 0, 0.008]}>
          <mesh position={[-0.01, -0.002, 0]} rotation={[0, 0, -0.28]}>
            <boxGeometry args={[0.009, 0.042, 0.008]} />
            <meshBasicMaterial color={mainColor} />
          </mesh>
          <mesh position={[0.01, -0.002, 0]} rotation={[0, 0, 0.28]}>
            <boxGeometry args={[0.009, 0.042, 0.008]} />
            <meshBasicMaterial color={mainColor} />
          </mesh>
          <mesh position={[0, -0.006, 0]}>
            <boxGeometry args={[0.024, 0.007, 0.008]} />
            <meshBasicMaterial color={mainColor} />
          </mesh>
        </group>
      )}
      {motif === "quill" && (
        <group position={[0, 0, 0.008]} rotation={[0, 0, -0.45]}>
          <mesh position={[0, 0.006, 0]}>
            <coneGeometry args={[0.018, 0.04, 4]} />
            <meshBasicMaterial color={mainColor} />
          </mesh>
          <mesh position={[0, -0.016, 0]}>
            <boxGeometry args={[0.007, 0.02, 0.008]} />
            <meshBasicMaterial color={mainColor} />
          </mesh>
        </group>
      )}
      {motif === "dot" && (
        <mesh position={[0, 0, 0.008]}>
          <sphereGeometry args={[0.018, 8, 8]} />
          <meshBasicMaterial color={mainColor} />
        </mesh>
      )}
    </group>
  )
}

function CharacterHeadMesh({
  identity,
  zSign,
  dozing,
}: {
  identity: CharacterIdentity
  zSign: number
  dozing: boolean
}) {
  const { headSilhouette, mainColor, softColor, fgColor } = identity
  const eyeScaleY = dozing ? 0.22 : 1
  const frontZ = zSign

  return (
    <group>
      {/* Head geometry derived from web/src/components/agent-avatar.tsx */}
      {headSilhouette === "round_one_antenna" && (
        <>
          <mesh castShadow>
            <sphereGeometry args={[0.17, 14, 12]} />
            <meshStandardMaterial color={mainColor} roughness={0.42} />
          </mesh>
          {/* Single top antenna + tip ball */}
          <mesh position={[0, 0.21, 0]} castShadow>
            <cylinderGeometry args={[0.014, 0.014, 0.1, 8]} />
            <meshStandardMaterial color={mainColor} roughness={0.4} />
          </mesh>
          <mesh position={[0, 0.27, 0]} castShadow>
            <sphereGeometry args={[0.034, 10, 10]} />
            <meshStandardMaterial color={mainColor} roughness={0.35} />
          </mesh>
          {/* Two soft eyes */}
          <mesh position={[-0.055, 0.01, 0.155 * frontZ]} scale={[1, eyeScaleY, 1]}>
            <sphereGeometry args={[0.026, 8, 8]} />
            <meshBasicMaterial color={softColor} />
          </mesh>
          <mesh position={[0.055, 0.01, 0.155 * frontZ]} scale={[1, eyeScaleY, 1]}>
            <sphereGeometry args={[0.026, 8, 8]} />
            <meshBasicMaterial color={softColor} />
          </mesh>
        </>
      )}

      {headSilhouette === "square_visor" && (
        <>
          <mesh castShadow>
            <boxGeometry args={[0.31, 0.28, 0.28]} />
            <meshStandardMaterial color={mainColor} roughness={0.42} />
          </mesh>
          {/* Visor band across face */}
          <mesh position={[0, 0.01, 0.138 * frontZ]}>
            <boxGeometry args={[0.23, 0.11, 0.025]} />
            <meshBasicMaterial color={softColor} />
          </mesh>
          {/* Two pupils inside visor */}
          <mesh position={[-0.055, 0.01, 0.152 * frontZ]} scale={[1, eyeScaleY, 1]}>
            <sphereGeometry args={[0.022, 8, 8]} />
            <meshBasicMaterial color={mainColor} />
          </mesh>
          <mesh position={[0.055, 0.01, 0.152 * frontZ]} scale={[1, eyeScaleY, 1]}>
            <sphereGeometry args={[0.022, 8, 8]} />
            <meshBasicMaterial color={mainColor} />
          </mesh>
        </>
      )}

      {headSilhouette === "round_pointed_ears" && (
        <>
          <mesh castShadow>
            <sphereGeometry args={[0.175, 14, 12]} />
            <meshStandardMaterial color={mainColor} roughness={0.42} />
          </mesh>
          {/* Two pointed ears */}
          <mesh position={[-0.12, 0.17, 0]} rotation={[0, 0, 0.38]} castShadow>
            <coneGeometry args={[0.055, 0.13, 6]} />
            <meshStandardMaterial color={mainColor} roughness={0.42} />
          </mesh>
          <mesh position={[0.12, 0.17, 0]} rotation={[0, 0, -0.38]} castShadow>
            <coneGeometry args={[0.055, 0.13, 6]} />
            <meshStandardMaterial color={mainColor} roughness={0.42} />
          </mesh>
          <mesh position={[-0.055, 0.01, 0.16 * frontZ]} scale={[1, eyeScaleY, 1]}>
            <sphereGeometry args={[0.026, 8, 8]} />
            <meshBasicMaterial color={softColor} />
          </mesh>
          <mesh position={[0.055, 0.01, 0.16 * frontZ]} scale={[1, eyeScaleY, 1]}>
            <sphereGeometry args={[0.026, 8, 8]} />
            <meshBasicMaterial color={softColor} />
          </mesh>
        </>
      )}

      {headSilhouette === "one_big_eye" && (
        <>
          <mesh castShadow>
            <sphereGeometry args={[0.18, 14, 12]} />
            <meshStandardMaterial color={mainColor} roughness={0.42} />
          </mesh>
          {/* One big cyclops eye + pupil */}
          <mesh position={[0, 0.025, 0.16 * frontZ]} scale={[1, eyeScaleY, 1]}>
            <sphereGeometry args={[0.068, 12, 12]} />
            <meshBasicMaterial color={softColor} />
          </mesh>
          <mesh position={[0, 0.025, 0.21 * frontZ]} scale={[1, eyeScaleY, 1]}>
            <sphereGeometry args={[0.032, 10, 10]} />
            <meshBasicMaterial color={fgColor} />
          </mesh>
          {/* Small mouth line below */}
          <mesh position={[0, -0.095, 0.155 * frontZ]}>
            <boxGeometry args={[0.09, 0.018, 0.02]} />
            <meshBasicMaterial color={softColor} />
          </mesh>
        </>
      )}

      {headSilhouette === "square_side_bolts" && (
        <>
          <mesh castShadow>
            <boxGeometry args={[0.29, 0.29, 0.27]} />
            <meshStandardMaterial color={mainColor} roughness={0.42} />
          </mesh>
          {/* Side bolts */}
          <mesh position={[-0.175, 0, 0]} rotation={[0, 0, Math.PI / 2]} castShadow>
            <cylinderGeometry args={[0.024, 0.024, 0.07, 8]} />
            <meshStandardMaterial color={mainColor} roughness={0.4} />
          </mesh>
          <mesh position={[0.175, 0, 0]} rotation={[0, 0, Math.PI / 2]} castShadow>
            <cylinderGeometry args={[0.024, 0.024, 0.07, 8]} />
            <meshStandardMaterial color={mainColor} roughness={0.4} />
          </mesh>
          <mesh position={[-0.055, 0.03, 0.136 * frontZ]} scale={[1, eyeScaleY, 1]}>
            <sphereGeometry args={[0.025, 8, 8]} />
            <meshBasicMaterial color={softColor} />
          </mesh>
          <mesh position={[0.055, 0.03, 0.136 * frontZ]} scale={[1, eyeScaleY, 1]}>
            <sphereGeometry args={[0.025, 8, 8]} />
            <meshBasicMaterial color={softColor} />
          </mesh>
          {/* Bracket mouth */}
          <mesh position={[0, -0.055, 0.136 * frontZ]}>
            <boxGeometry args={[0.11, 0.02, 0.015]} />
            <meshBasicMaterial color={softColor} />
          </mesh>
        </>
      )}

      {headSilhouette === "wide_two_antennae" && (
        <>
          <mesh castShadow>
            <boxGeometry args={[0.35, 0.22, 0.26]} />
            <meshStandardMaterial color={mainColor} roughness={0.42} />
          </mesh>
          {/* Two stubby angled antennae + tips */}
          <mesh position={[-0.1, 0.15, 0]} rotation={[0, 0, 0.32]} castShadow>
            <cylinderGeometry args={[0.013, 0.013, 0.1, 8]} />
            <meshStandardMaterial color={mainColor} roughness={0.4} />
          </mesh>
          <mesh position={[-0.12, 0.2, 0]} castShadow>
            <sphereGeometry args={[0.028, 8, 8]} />
            <meshStandardMaterial color={mainColor} roughness={0.35} />
          </mesh>
          <mesh position={[0.1, 0.15, 0]} rotation={[0, 0, -0.32]} castShadow>
            <cylinderGeometry args={[0.013, 0.013, 0.1, 8]} />
            <meshStandardMaterial color={mainColor} roughness={0.4} />
          </mesh>
          <mesh position={[0.12, 0.2, 0]} castShadow>
            <sphereGeometry args={[0.028, 8, 8]} />
            <meshStandardMaterial color={mainColor} roughness={0.35} />
          </mesh>
          <mesh position={[-0.06, -0.01, 0.132 * frontZ]} scale={[1, eyeScaleY, 1]}>
            <sphereGeometry args={[0.026, 8, 8]} />
            <meshBasicMaterial color={softColor} />
          </mesh>
          <mesh position={[0.06, -0.01, 0.132 * frontZ]} scale={[1, eyeScaleY, 1]}>
            <sphereGeometry args={[0.026, 8, 8]} />
            <meshBasicMaterial color={softColor} />
          </mesh>
        </>
      )}

      {headSilhouette === "neutral" && (
        <>
          <mesh castShadow>
            <boxGeometry args={[0.28, 0.28, 0.26]} />
            <meshStandardMaterial color={mainColor} roughness={0.45} />
          </mesh>
          <mesh position={[-0.055, 0.02, 0.132 * frontZ]} scale={[1, eyeScaleY, 1]}>
            <sphereGeometry args={[0.025, 8, 8]} />
            <meshBasicMaterial color={softColor} />
          </mesh>
          <mesh position={[0.055, 0.02, 0.132 * frontZ]} scale={[1, eyeScaleY, 1]}>
            <sphereGeometry args={[0.025, 8, 8]} />
            <meshBasicMaterial color={softColor} />
          </mesh>
          <mesh position={[0, -0.05, 0.132 * frontZ]}>
            <boxGeometry args={[0.08, 0.018, 0.015]} />
            <meshBasicMaterial color={softColor} />
          </mesh>
        </>
      )}

      {headSilhouette === "human" && (
        <>
          {/* Human Director head with hair cap */}
          <mesh castShadow>
            <sphereGeometry args={[0.165, 14, 12]} />
            <meshStandardMaterial color="#eab68c" roughness={0.55} />
          </mesh>
          <mesh position={[0, 0.055, -0.015 * frontZ]} castShadow>
            <sphereGeometry args={[0.172, 12, 10, 0, Math.PI * 2, 0, Math.PI * 0.58]} />
            <meshStandardMaterial color={fgColor} roughness={0.75} />
          </mesh>
          <mesh position={[-0.05, 0.01, 0.152 * frontZ]} scale={[1, eyeScaleY, 1]}>
            <sphereGeometry args={[0.02, 8, 8]} />
            <meshBasicMaterial color={fgColor} />
          </mesh>
          <mesh position={[0.05, 0.01, 0.152 * frontZ]} scale={[1, eyeScaleY, 1]}>
            <sphereGeometry args={[0.02, 8, 8]} />
            <meshBasicMaterial color={fgColor} />
          </mesh>
        </>
      )}
    </group>
  )
}

function ArmMesh({
  side,
  armPose,
  color,
  zSign,
  handRef,
}: {
  side: "left" | "right"
  armPose: CharacterPose["leftArm"]
  color: string
  zSign: number
  handRef?: React.RefObject<Group | null>
}) {
  const xSign = side === "left" ? -1 : 1
  const shoulderX = 0.2 * xSign

  let rotX = 0.35 * zSign
  let rotZ = 0
  let handPos: [number, number, number] = [0, -0.1, 0.18 * zSign]

  if (armPose === "typing") {
    rotX = 0.72 * zSign
    handPos = [0, -0.05, 0.25 * zSign]
  } else if (armPose === "raised") {
    rotX = -2.45 * zSign
    rotZ = -0.15 * xSign
    handPos = [0, 0.26, 0.04 * zSign]
  } else if (armPose === "stretch") {
    rotX = -2.2 * zSign
    rotZ = -0.42 * xSign
    handPos = [0.06 * xSign, 0.24, -0.02 * zSign]
  } else if (armPose === "slumped") {
    rotX = 0.22 * zSign
    handPos = [0, -0.19, 0.08 * zSign]
  }

  return (
    <group position={[shoulderX, 0.11, 0]}>
      <group ref={handRef} rotation={[rotX, 0, rotZ]}>
        <mesh position={[0, -0.08, 0.07 * zSign]} castShadow>
          <capsuleGeometry args={[0.036, 0.14, 5, 8]} />
          <meshStandardMaterial color={color} roughness={0.48} />
        </mesh>
        <mesh position={handPos} castShadow>
          <sphereGeometry args={[0.044, 8, 8]} />
          <meshStandardMaterial color={color} roughness={0.42} />
        </mesh>
      </group>
    </group>
  )
}

function FocusRing({ scale, color }: { scale: number; color: string }) {
  return (
    <mesh position={[0, 0.03, 0]} rotation={[-Math.PI / 2, 0, 0]}>
      <ringGeometry args={[0.86 * scale, 1.02 * scale, 40]} />
      <meshBasicMaterial color={color} transparent opacity={0.92} depthWrite={false} />
    </mesh>
  )
}

function MentionPulseRing({ color }: { color: string }) {
  const meshRef = useRef<Mesh>(null)
  const matRef = useRef<MeshBasicMaterial>(null)
  useFrame(({ clock }) => {
    const t = (clock.elapsedTime % 1.8) / 1.8
    const spread = 1 + t * 0.5
    if (meshRef.current) meshRef.current.scale.setScalar(spread)
    if (matRef.current) matRef.current.opacity = 0.38 * (1 - t)
  })
  return (
    <mesh ref={meshRef} position={[0, 0.025, 0]} rotation={[-Math.PI / 2, 0, 0]}>
      <ringGeometry args={[0.7, 0.84, 32]} />
      <meshBasicMaterial ref={matRef} color={color} transparent opacity={0.38} depthWrite={false} />
    </mesh>
  )
}

export function CharacterSeatGroup({
  seat,
  roomWidth,
  roomHeight,
  palette,
  theme,
  selected,
  focused,
  mentioned,
  placementsRef,
  reducedMotion,
  walkingOut,
  mergeAnim,
  now,
  onSelect,
  onOpenApproval,
}: {
  seat: Seat
  roomWidth: number
  roomHeight: number
  palette: ScenePalette
  theme: "light" | "dark"
  selected: boolean
  focused: boolean
  mentioned: boolean
  placementsRef: RefObject<Map<string, NameLabelPlacement>>
  reducedMotion: boolean
  walkingOut: boolean
  mergeAnim: MergeAnimation | null
  now: number
  onSelect: (desk: DeskInfo) => void
  onOpenApproval?: ((desk: DeskInfo) => void) | undefined
}) {
  const { desk, scale, facing } = seat
  const { member, palette: hue } = desk
  const identity = useMemo(() => deriveCharacterIdentity(desk, theme), [desk, theme])
  const pose = useMemo(() => deriveCharacterPose(desk, { reducedMotion }), [desk, reducedMotion])
  const seed = useMemo(() => seedFromId(member.id), [member.id])
  const label = member.display_name.trim() || member.handle
  const codeTexture = useContext(CodeScreenContext)

  const { x, z, zSign, deskOffsetZ, chairOffsetZ, facingYaw } = seatWorldCoords(seat, roomWidth, roomHeight)
  const deskW = 1.68 * scale
  const deskD = 0.9 * scale
  const deskH = 0.42 * scale
  const dimmed = desk.outOfQuota || desk.state === "out_of_quota"

  const torsoGroupRef = useRef<Group>(null)
  const headGroupRef = useRef<Group>(null)
  const leftArmRef = useRef<Group>(null)
  const rightArmRef = useRef<Group>(null)
  const screenMatRef = useRef<MeshStandardMaterial>(null)
  const stackRef = useRef<HTMLDivElement>(null)

  useFrame(({ clock }) => {
    if (!pose.animated || reducedMotion || !pose.seated || walkingOut) {
      if (torsoGroupRef.current) torsoGroupRef.current.scale.y = 1
      return
    }
    const t = clock.getElapsedTime()
    const sample = sampleCharacterFrame(pose, t, seed)
    if (torsoGroupRef.current) {
      torsoGroupRef.current.rotation.x = sample.torsoLean
      torsoGroupRef.current.scale.y = 1 + sample.breath
    }
    if (headGroupRef.current) {
      headGroupRef.current.rotation.x = sample.headPitch
      headGroupRef.current.rotation.y = sample.headYaw
    }
    if (leftArmRef.current && pose.leftArm === "typing") {
      leftArmRef.current.position.y = sample.leftHandOffsetY
    }
    if (rightArmRef.current && (pose.rightArm === "typing" || pose.rightArm === "raised")) {
      rightArmRef.current.position.y = sample.rightHandOffsetY
    }
    if (screenMatRef.current && pose.monitorMode === "glow" && !codeTexture) {
      screenMatRef.current.emissiveIntensity = 1.05 + Math.sin(t * 3.2) * 0.32
    }
  })

  const monitorColor =
    pose.monitorMode === "glow"
      ? hue.accent
      : pose.monitorMode === "approval"
        ? palette.warn
        : pose.monitorMode === "error"
          ? palette.danger
          : pose.monitorMode === "persona_badge"
            ? hue.bg
            : palette.code

  const monitorEmissive =
    pose.monitorMode === "glow"
      ? hue.accent
      : pose.monitorMode === "approval"
        ? palette.warn
        : pose.monitorMode === "error"
          ? palette.danger
          : pose.monitorMode === "persona_badge"
            ? hue.accent
            : palette.line

  const monitorIntensity =
    pose.monitorMode === "glow"
      ? 1.15
      : pose.monitorMode === "approval" || pose.monitorMode === "error"
        ? 0.55
        : pose.monitorMode === "persona_badge"
          ? 0.45
          : 0.1

  const mergeSample = mergeAnim ? sampleMergePop(mergeAnim, now, reducedMotion) : null

  return (
    <group
      position={[x, 0, z]}
      onClick={(event) => {
        event.stopPropagation()
        onSelect(desk)
      }}
    >
      {/* Floor selection highlight */}
      {selected && (
        <mesh position={[0, 0.015, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[deskW + 0.5, deskD + 0.95]} />
          <meshBasicMaterial color={palette.accent} transparent opacity={0.28} />
        </mesh>
      )}

      {/* Keyboard focus ring, kept visible under reduced motion */}
      {focused && <FocusRing scale={scale} color={palette.accent} />}

      {/* Soft pulse on a desk mentioned in the last minute. Off under reduced motion. */}
      {mentioned && !reducedMotion && <MentionPulseRing color={palette.accent} />}

      {/* Hue lip on the edge the sitter faces, so the desk front reads into the room for the Director */}
      <mesh position={[0, deskH + 0.02, deskOffsetZ + 0.38 * scale * zSign]}>
        <boxGeometry args={[deskW * 0.86, 0.03, 0.05]} />
        <meshBasicMaterial color={identity.mainColor} />
      </mesh>

      {/* Monitor screen face, turned toward the sitter. Working screens share one scrolling code texture. */}
      <mesh
        position={[0, deskH + 0.25 * scale, deskOffsetZ - 0.034 * scale * zSign]}
        rotation={[0, monitorScreenYaw(facing), 0]}
      >
        <planeGeometry args={[0.58 * scale, 0.3 * scale]} />
        <meshStandardMaterial
          ref={screenMatRef}
          color={pose.monitorMode === "glow" && codeTexture ? "#d7e4ea" : monitorColor}
          map={pose.monitorMode === "glow" ? (codeTexture ?? undefined) : undefined}
          emissive={monitorEmissive}
          emissiveIntensity={pose.monitorMode === "glow" && codeTexture ? 0.28 : monitorIntensity}
          roughness={0.4}
        />
      </mesh>

      {/* Queued state: clock on the monitor */}
      {pose.monitorMode === "clock" && (
        <group position={[0, deskH + 0.25 * scale, deskOffsetZ - 0.04 * scale * zSign]}>
          <mesh>
            <torusGeometry args={[0.095 * scale, 0.012 * scale, 8, 20]} />
            <meshBasicMaterial color={palette.ink} />
          </mesh>
          <mesh position={[0, 0.028 * scale, 0]}>
            <boxGeometry args={[0.014 * scale, 0.06 * scale, 0.01]} />
            <meshBasicMaterial color={palette.ink} />
          </mesh>
          <mesh position={[0.025 * scale, 0, 0]} rotation={[0, 0, -Math.PI / 3]}>
            <boxGeometry args={[0.014 * scale, 0.05 * scale, 0.01]} />
            <meshBasicMaterial color={palette.accent} />
          </mesh>
        </group>
      )}

      {/* Busy for a persona: monitor showing the persona's badge */}
      {pose.monitorMode === "persona_badge" && pose.personaBadgeMotif && (
        <group position={[0, deskH + 0.25 * scale, deskOffsetZ - 0.042 * scale * zSign]}>
          <RolePinMesh
            motif={pose.personaBadgeMotif}
            mainColor={identity.mainColor}
            softColor={identity.softColor}
            zSign={1}
          />
        </group>
      )}

      {/* Soft glow halo on desk surface when working */}
      {pose.monitorMode === "glow" && (
        <mesh position={[0, deskH + 0.004, deskOffsetZ - 0.14 * scale * zSign]} rotation={[-Math.PI / 2, 0, 0]}>
          <circleGeometry args={[0.52 * scale, 24]} />
          <meshBasicMaterial color={hue.accent} transparent opacity={0.28} />
        </mesh>
      )}

      {/* Failed state: red desk lamp on the corner of the desk */}
      {pose.showRedLamp && (
        <group position={[0.58 * scale, deskH, deskOffsetZ - 0.12 * scale * zSign]}>
          <mesh position={[0, 0.02 * scale, 0]}>
            <cylinderGeometry args={[0.08 * scale, 0.1 * scale, 0.04 * scale, 10]} />
            <meshStandardMaterial color={palette.line} roughness={0.6} />
          </mesh>
          <mesh position={[0, 0.16 * scale, 0]} rotation={[0, 0, 0.18]}>
            <cylinderGeometry args={[0.018 * scale, 0.018 * scale, 0.28 * scale, 8]} />
            <meshStandardMaterial color={palette.faint} roughness={0.5} />
          </mesh>
          <mesh position={[-0.04 * scale, 0.3 * scale, 0]} rotation={[0, 0, 0.35]}>
            <coneGeometry args={[0.11 * scale, 0.14 * scale, 12]} />
            <meshStandardMaterial
              color={palette.danger}
              emissive={palette.danger}
              emissiveIntensity={1.35}
              roughness={0.3}
            />
          </mesh>
          <mesh position={[-0.06 * scale, 0.005, 0]} rotation={[-Math.PI / 2, 0, 0]}>
            <circleGeometry args={[0.28 * scale, 16]} />
            <meshBasicMaterial color={palette.danger} transparent opacity={0.32} />
          </mesh>
        </group>
      )}

      {/* Merge check mark pop over the desk */}
      {mergeSample && (
        <Billboard position={[0, deskH + (0.85 + mergeSample.offsetY) * scale, deskOffsetZ]}>
          <Html center transform={false} zIndexRange={[18, 0]}>
            <span
              data-testid={`merge-check3d-${member.id}`}
              style={{
                transform: `scale(${mergeSample.scale.toFixed(2)})`,
                opacity: mergeSample.opacity,
              }}
              className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-ok bg-ok-soft font-mono text-[12px] font-bold text-ok shadow-xs"
            >
              <svg viewBox="0 0 12 12" className="h-3.5 w-3.5" fill="none" aria-hidden="true">
                <path d="M2.5 6.2 5 8.7 9.5 3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
          </Html>
        </Billboard>
      )}

      {/* Seated 3D character figure (hidden when out of quota or currently walking a handoff) */}
      {pose.seated && !walkingOut && (
        <group position={[0, 0.34 * scale, chairOffsetZ]} rotation={[0, facingYaw, 0]} scale={[scale, scale, scale]}>
          {/* Seated thighs/legs. Local +z is the face; facingYaw turns the Director into the room. */}
          <mesh position={[-0.08, 0, 0.1]} rotation={[Math.PI / 2, 0, 0]} castShadow>
            <capsuleGeometry args={[0.042, 0.14, 5, 8]} />
            <meshStandardMaterial color={identity.fgColor} roughness={0.65} />
          </mesh>
          <mesh position={[0.08, 0, 0.1]} rotation={[Math.PI / 2, 0, 0]} castShadow>
            <capsuleGeometry args={[0.042, 0.14, 5, 8]} />
            <meshStandardMaterial color={identity.fgColor} roughness={0.65} />
          </mesh>

          {/* Torso + arms + head */}
          <group ref={torsoGroupRef} position={[0, 0.18, 0]} rotation={[pose.torsoLean, 0, 0]}>
            <mesh castShadow receiveShadow>
              <boxGeometry args={[0.32, 0.34, 0.24]} />
              <meshStandardMaterial color={identity.mainColor} roughness={0.46} />
            </mesh>

            {/* Persona role chest pin */}
            {identity.pinMotif && (
              <RolePinMesh
                motif={identity.pinMotif}
                mainColor={identity.mainColor}
                softColor={identity.softColor}
                zSign={1}
              />
            )}

            <ArmMesh
              side="left"
              armPose={pose.leftArm}
              color={identity.mainColor}
              zSign={1}
              handRef={leftArmRef}
            />
            <ArmMesh
              side="right"
              armPose={pose.rightArm}
              color={identity.mainColor}
              zSign={1}
              handRef={rightArmRef}
            />

            <group
              ref={headGroupRef}
              position={[0, 0.36, 0]}
              rotation={[pose.headPitch, pose.headYaw, 0]}
            >
              <CharacterHeadMesh identity={identity} zSign={1} dozing={false} />
            </group>
          </group>
        </group>
      )}

      {/* One label per desk: name, status badge, approval, and quota note move and hide together. */}
      <LabelPlacement id={member.id} placementsRef={placementsRef} targetRef={stackRef} />
      <Billboard position={[0, 1.38 * scale, chairOffsetZ]}>
        <Html center transform={false} zIndexRange={[12, 0]}>
            <div ref={stackRef} className="flex flex-col items-center gap-1">
              <button
                type="button"
                data-testid={`desk3d-${member.id}`}
                data-pose={pose.pose}
                data-cli={identity.cli}
                data-role-pin={identity.rolePin ?? undefined}
                data-focused={focused ? "true" : "false"}
                aria-label={`${label}, ${desk.stateLabel}`}
                onClick={(event) => {
                  event.stopPropagation()
                  onSelect(desk)
                }}
                className="rounded-md outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                <span
                  data-testid={`desk3d-label-${member.id}`}
                  className={cx(
                    "inline-flex max-w-36 items-center gap-1.5 rounded-md border border-line bg-surface px-2 py-0.5 font-sans text-[12px] font-semibold text-ink shadow-xs",
                    dimmed && "opacity-60",
                  )}
                >
                  <span
                    data-status={desk.state}
                    className={cx(
                      "h-1.5 w-1.5 shrink-0 rounded-full",
                      statusDotClass(desk.state, dimmed),
                      desk.state === "working" && !reducedMotion && "animate-pulse motion-reduce:animate-none",
                    )}
                    aria-hidden="true"
                  />
                  <span className="truncate">{label}</span>
                </span>
              </button>
              {pose.showApprovalCard && (
                <button
                  type="button"
                  data-testid={`approval-card3d-${member.id}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    onSelect(desk)
                    onOpenApproval?.(desk)
                  }}
                  className="inline-flex min-h-6 items-center gap-1 rounded-md border border-warn bg-warn-soft px-1.5 py-0.5 font-sans text-[11px] font-medium text-warn shadow-xs hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-warn" aria-hidden="true" />
                  Waiting
                </button>
              )}
              {!pose.seated && pose.quotaNote && (
                <span
                  data-testid={`quota-note3d-${member.id}`}
                  className="pointer-events-none select-none whitespace-nowrap rounded-md border border-line bg-surface px-1.5 py-0.5 font-sans text-[11px] tabular-nums text-danger"
                >
                  {pose.quotaNote}
                </span>
              )}
            </div>
        </Html>
      </Billboard>
    </group>
  )
}

export function WalkingHandoffActor3D({
  anim,
  fromSeat,
  toSeat,
  roomWidth,
  roomHeight,
  theme,
  now,
  reducedMotion,
}: {
  anim: HandoffAnimation
  fromSeat: Seat
  toSeat: Seat
  roomWidth: number
  roomHeight: number
  theme: "light" | "dark"
  now: number
  reducedMotion: boolean
}) {
  const fromCoords = seatWorldCoords(fromSeat, roomWidth, roomHeight)
  const toCoords = seatWorldCoords(toSeat, roomWidth, roomHeight)
  const fromPos: [number, number, number] = [fromCoords.x, 0, fromCoords.z + fromCoords.chairOffsetZ]
  const toPos: [number, number, number] = [toCoords.x, 0, toCoords.z + toCoords.chairOffsetZ]
  const identity = useMemo(() => deriveCharacterIdentity(fromSeat.desk, theme), [fromSeat.desk, theme])
  const sample = sampleHandoffWalk(anim, fromPos, toPos, now, reducedMotion)

  return (
    <group position={sample.position} rotation={[0, sample.yaw, 0]}>
      {/* Walking legs */}
      <mesh position={[-0.08, 0.18, 0]} rotation={[sample.strideAngle, 0, 0]} castShadow>
        <capsuleGeometry args={[0.04, 0.18, 5, 8]} />
        <meshStandardMaterial color={identity.fgColor} roughness={0.65} />
      </mesh>
      <mesh position={[0.08, 0.18, 0]} rotation={[-sample.strideAngle, 0, 0]} castShadow>
        <capsuleGeometry args={[0.04, 0.18, 5, 8]} />
        <meshStandardMaterial color={identity.fgColor} roughness={0.65} />
      </mesh>

      {/* Standing torso + head */}
      <group position={[0, 0.48, 0]}>
        <mesh castShadow>
          <boxGeometry args={[0.32, 0.34, 0.24]} />
          <meshStandardMaterial color={identity.mainColor} roughness={0.46} />
        </mesh>
        {identity.pinMotif && (
          <RolePinMesh
            motif={identity.pinMotif}
            mainColor={identity.mainColor}
            softColor={identity.softColor}
            zSign={1}
          />
        )}
        <group position={[0, 0.36, 0]}>
          <CharacterHeadMesh identity={identity} zSign={1} dozing={false} />
        </group>

        {/* Paper carried in hand on outbound leg */}
        {sample.hasPaper && (
          <group position={[0.18, 0.04, 0.22]} rotation={[0.35, 0, -0.15]}>
            <mesh castShadow>
              <boxGeometry args={[0.18, 0.24, 0.015]} />
              <meshStandardMaterial color="#ffffff" roughness={0.4} />
            </mesh>
            <mesh position={[0, 0.05, 0.01]}>
              <boxGeometry args={[0.12, 0.018, 0.005]} />
              <meshBasicMaterial color={identity.mainColor} />
            </mesh>
          </group>
        )}
      </group>
    </group>
  )
}

export function TaskBoard3D({
  notes,
  floorD,
  wallT,
  palette,
}: {
  notes: TaskBoardNote[]
  floorD: number
  wallT: number
  palette: ScenePalette
}) {
  const boardW = Math.max(2.6, Math.min(6.4, notes.length * 1.15 + 0.8))
  const boardH = 0.78
  const z = -floorD / 2 + wallT + 0.03

  return (
    <group position={[0, 0.64, z]}>
      {/* Board frame on the back wall */}
      <mesh receiveShadow>
        <boxGeometry args={[boardW, boardH, 0.04]} />
        <meshStandardMaterial color={palette.surface} roughness={0.75} />
        <Edges threshold={15} color={palette.line} />
      </mesh>
      {notes.slice(0, 6).map((note, index, list) => {
        const span = (list.length - 1) * 0.92
        const nx = -span / 2 + index * 0.92
        return (
          <group key={note.id} position={[nx, -0.02, 0.03]}>
            <mesh>
              <boxGeometry args={[0.78, 0.46, 0.02]} />
              <meshStandardMaterial color={note.bg} roughness={0.6} />
              <Edges threshold={15} color={note.accent} />
            </mesh>
            <mesh position={[0, 0.18, 0.012]}>
              <boxGeometry args={[0.78, 0.08, 0.01]} />
              <meshBasicMaterial color={note.accent} />
            </mesh>
          </group>
        )
      })}
    </group>
  )
}

export function LaneMeterStrip3D({
  bars,
  floorW,
  wallT,
  palette,
}: {
  bars: LaneMeterBar[]
  floorW: number
  wallT: number
  palette: ScenePalette
}) {
  if (bars.length === 0) return null
  const stripD = Math.max(1.8, Math.min(5.2, bars.length * 0.56 + 0.5))
  const stripH = 0.62
  const x = -floorW / 2 + wallT + 0.03

  return (
    <group position={[x, 0.48, 0]}>
      <mesh receiveShadow>
        <boxGeometry args={[0.04, stripH, stripD]} />
        <meshStandardMaterial color={palette.surface} roughness={0.75} />
        <Edges threshold={15} color={palette.line} />
      </mesh>
      {bars.slice(0, 8).map((bar, index, list) => {
        const span = (list.length - 1) * 0.48
        const bz = -span / 2 + index * 0.48
        const fullH = 0.42
        const barH = Math.max(0.06, fullH * bar.fillRatio)
        return (
          <group key={bar.id} position={[0.03, -fullH / 2 + barH / 2 - 0.02, bz]}>
            <mesh>
              <boxGeometry args={[0.03, barH, 0.24]} />
              <meshStandardMaterial
                color={bar.color}
                emissive={bar.color}
                emissiveIntensity={0.45}
                roughness={0.35}
              />
            </mesh>
          </group>
        )
      })}
    </group>
  )
}

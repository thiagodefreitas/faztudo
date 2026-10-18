import { motion } from "motion/react"
import type { KeyboardEvent, MouseEvent } from "react"
import { identityOf } from "../../lib/avatar"
import { cx } from "../../lib/cx"
import {
  type Character2DView,
  derive2DCharacterView,
  type HeadSilhouette,
  type PinMotif,
} from "./avatar"
import { DESK_H, DESK_W } from "./layout"
import type { DeskInfo, DeskState } from "./state"

export interface OfficeDeskProps {
  desk: DeskInfo
  selected: boolean
  reducedMotion: boolean
  onSelect: (desk: DeskInfo) => void
  onOpenApproval: (desk: DeskInfo) => void
}

const BADGE_CLASS: Record<DeskState, string> = {
  idle: "bg-sidebar text-muted border-line",
  working: "bg-accent-soft text-accent border-accent/30",
  queued: "bg-sidebar text-muted border-line",
  waiting_approval: "bg-warn-soft text-warn border-warn/40",
  failed: "bg-danger-soft text-danger border-danger/40",
  out_of_quota: "bg-danger-soft text-danger border-danger/40",
}

const BADGE_TEXT: Record<DeskState, string> = {
  idle: "Idle",
  working: "Working",
  queued: "Queued",
  waiting_approval: "Waiting for approval",
  failed: "Failed",
  out_of_quota: "Out of quota",
}

export function DeskStateIcon({ state, className }: { state: DeskState; className?: string }) {
  switch (state) {
    case "idle":
      return (
        <svg viewBox="0 0 12 12" className={className} fill="none" aria-hidden="true">
          <circle cx="6" cy="6" r="3.5" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      )
    case "working":
      return (
        <svg viewBox="0 0 12 12" className={className} fill="none" aria-hidden="true">
          <path d="M4 2.8 9.2 6 4 9.2Z" fill="currentColor" />
        </svg>
      )
    case "queued":
      return (
        <svg viewBox="0 0 12 12" className={className} fill="none" aria-hidden="true">
          <circle cx="6" cy="6" r="4.2" stroke="currentColor" strokeWidth="1.3" />
          <path d="M6 3.6V6l1.7 1.1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      )
    case "waiting_approval":
      return (
        <svg viewBox="0 0 12 12" className={className} fill="none" aria-hidden="true">
          <path
            d="M3.6 6.8V3.2M5.2 6.8V2.2M6.8 6.8V2.6M8.4 6.8V3.8M3.6 6.8c0 2 4.8 2 4.8 0"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
        </svg>
      )
    case "failed":
      return (
        <svg viewBox="0 0 12 12" className={className} fill="none" aria-hidden="true">
          <rect x="1.8" y="1.8" width="8.4" height="8.4" rx="1.6" stroke="currentColor" strokeWidth="1.3" />
          <path d="M4.1 4.1 7.9 7.9M7.9 4.1 4.1 7.9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      )
    case "out_of_quota":
      return (
        <svg viewBox="0 0 12 12" className={className} fill="none" aria-hidden="true">
          <circle cx="6" cy="6" r="4.2" stroke="currentColor" strokeWidth="1.3" />
          <path d="M3.1 8.9 8.9 3.1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      )
  }
}

export function DeskStateBadge({
  state,
  onClick,
  testId,
}: {
  state: DeskState
  onClick?: (event: MouseEvent<HTMLElement>) => void
  testId?: string
}) {
  return (
    <span
      data-testid={testId}
      data-state-badge={state}
      onClick={onClick}
      className={cx(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
        BADGE_CLASS[state],
        onClick && "cursor-pointer underline-offset-2 hover:underline",
      )}
    >
      <DeskStateIcon state={state} className="h-3 w-3 shrink-0" />
      <span>{BADGE_TEXT[state]}</span>
    </span>
  )
}

// The accent and soft tint of a desk, as CSS variables so light and dark work.
// A human Director has no hue of its own and uses the brand accent.
function hueVars(desk: DeskInfo): { accent: string; soft: string } {
  if (desk.isDirector) return { accent: "var(--color-accent)", soft: "var(--color-accent-soft)" }
  const slot = (identityOf(desk.member).slot % 6) + 1
  return { accent: `var(--color-agent-${slot})`, soft: `var(--color-agent-${slot}-soft)` }
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text
}

const SCREEN_STROKE: Partial<Record<DeskState, string>> = {
  waiting_approval: "var(--color-warn)",
  failed: "var(--color-danger)",
}

function seedFromId(id: string): number {
  let hash = 0
  for (let i = 0; i < id.length; i += 1) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0
  }
  return hash
}

function MotifGlyph({
  motif,
  cx: x,
  cy: y,
  color,
  scale = 1,
}: {
  motif: PinMotif
  cx: number
  cy: number
  color: string
  scale?: number
}) {
  return (
    <g
      transform={`translate(${x} ${y}) scale(${scale})`}
      stroke={color}
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    >
      {motif === "</>" && (
        <path d="M-2.2 -1.6 -3.8 0 -2.2 1.6M2.2 -1.6 3.8 0 2.2 1.6M0.9 -2.2 -0.9 2.2" />
      )}
      {motif === "magnifier" && (
        <>
          <circle cx="-0.7" cy="-0.7" r="2" />
          <path d="M0.8 0.8 2.6 2.6" />
        </>
      )}
      {motif === "compass" && (
        <>
          <path d="M0 -2.4 -2 2.4M0 -2.4 2 2.4M-1.3 1H1.3" />
          <circle cx="0" cy="-2.5" r="0.4" fill={color} />
        </>
      )}
      {motif === "quill" && (
        <path d="M2.4 -2.4C-1.2 -2.4 -2.4 0 -2.4 2.4 0.4 2.2 2.4 0.6 2.4 -2.4ZM-2.4 2.4 -0.4 0.4" />
      )}
      {motif === "dot" && <circle cx="0" cy="0" r="1.3" fill={color} stroke="none" />}
    </g>
  )
}

function HeadEyes({
  x1 = -3.2,
  x2 = 3.2,
  y = 0,
  color,
  closed,
}: {
  x1?: number
  x2?: number
  y?: number
  color: string
  closed: boolean
}) {
  if (closed) {
    return (
      <g stroke={color} strokeWidth="1.4" strokeLinecap="round">
        <path d={`M${x1 - 1.4} ${y}H${x1 + 1.4}`} />
        <path d={`M${x2 - 1.4} ${y}H${x2 + 1.4}`} />
      </g>
    )
  }
  return (
    <g fill={color}>
      <circle cx={x1} cy={y} r="1.7" />
      <circle cx={x2} cy={y} r="1.7" />
    </g>
  )
}

function CharacterHead2D({
  silhouette,
  accent,
  soft,
  closed,
}: {
  silhouette: HeadSilhouette
  accent: string
  soft: string
  closed: boolean
}) {
  switch (silhouette) {
    case "round_one_antenna":
      return (
        <>
          <path d="M0 -9.5V-13" stroke={accent} strokeWidth="1.8" strokeLinecap="round" />
          <circle cx="0" cy="-14" r="2" fill={accent} />
          <circle cx="0" cy="0" r="9.5" fill={accent} />
          <HeadEyes y={0.5} color={soft} closed={closed} />
        </>
      )
    case "square_visor":
      return (
        <>
          <rect x="-10" y="-9" width="20" height="18" rx="4.5" fill={accent} />
          <rect x="-7" y="-3" width="14" height="6.8" rx="3" fill={soft} />
          <HeadEyes x1={-3} x2={3} y={0.4} color={accent} closed={closed} />
        </>
      )
    case "round_pointed_ears":
      return (
        <>
          <path
            d="M-8.5 -3 -8 -12.5 -2.5 -7.5ZM8.5 -3 8 -12.5 2.5 -7.5Z"
            fill={accent}
            stroke={accent}
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
          <circle cx="0" cy="0.5" r="9.5" fill={accent} />
          <HeadEyes y={0.8} color={soft} closed={closed} />
        </>
      )
    case "one_big_eye":
      return (
        <>
          <circle cx="0" cy="-0.5" r="9.8" fill={accent} />
          <circle cx="0" cy="-0.5" r="4.6" fill={soft} />
          {closed ? (
            <path d="M-2.4 -0.5H2.4" stroke={accent} strokeWidth="1.5" strokeLinecap="round" />
          ) : (
            <circle cx="0" cy="-0.5" r="2.1" fill={accent} />
          )}
          <path d="M-2.8 6.2H2.8" stroke={soft} strokeWidth="1.4" strokeLinecap="round" />
        </>
      )
    case "square_side_bolts":
      return (
        <>
          <path d="M-12 -3V3M12 -3V3" stroke={accent} strokeWidth="2" strokeLinecap="round" />
          <rect x="-9.5" y="-9" width="19" height="18" rx="2.5" fill={accent} />
          <HeadEyes y={-1.5} color={soft} closed={closed} />
          <path d="M-3.5 4.2H3.5" stroke={soft} strokeWidth="1.5" strokeLinecap="round" />
        </>
      )
    case "wide_two_antennae":
      return (
        <>
          <path d="M-5 -6.5 -7 -12M5 -6.5 7 -12" stroke={accent} strokeWidth="1.8" strokeLinecap="round" />
          <circle cx="-7.2" cy="-12.5" r="1.8" fill={accent} />
          <circle cx="7.2" cy="-12.5" r="1.8" fill={accent} />
          <rect x="-11" y="-6.5" width="22" height="14" rx="6.5" fill={accent} />
          <HeadEyes x1={-3.6} x2={3.6} y={0.5} color={soft} closed={closed} />
        </>
      )
    case "human":
      return (
        <>
          {/* Back hair crown */}
          <path d="M-9.6 0C-10 -8.5 10 -8.5 9.6 0Z" fill={accent} />
          {/* Ears */}
          <circle cx="-9.2" cy="0.6" r="1.7" fill={soft} stroke={accent} strokeWidth="1.2" />
          <circle cx="9.2" cy="0.6" r="1.7" fill={soft} stroke={accent} strokeWidth="1.2" />
          {/* Face */}
          <circle cx="0" cy="0.5" r="8.8" fill={soft} stroke={accent} strokeWidth="1.5" />
          {/* Parted front hair */}
          <path
            d="M-8.8 -0.8C-8.4 -7.5 8.4 -7.5 8.8 -0.8C5.5 -4.2 1.2 -4.4 -1.8 -2.3C-4.5 -4.2 -7 -3.4 -8.8 -0.8Z"
            fill={accent}
          />
          {/* Brows, eyes, and friendly smile */}
          <path d="M-4.6 -1.4H-1.8M1.8 -1.4H4.6" stroke={accent} strokeWidth="1.1" strokeLinecap="round" />
          <HeadEyes x1={-3} x2={3} y={1} color={accent} closed={closed} />
          <path
            d={closed ? "M-2 4.6H2" : "M-2.4 4.2Q0 5.9 2.4 4.2"}
            stroke={accent}
            strokeWidth="1.3"
            strokeLinecap="round"
            fill="none"
          />
        </>
      )
    case "neutral":
    default:
      return (
        <>
          <rect x="-9.5" y="-9" width="19" height="18" rx="9" fill={accent} />
          <HeadEyes y={-1} color={soft} closed={closed} />
          <path d="M-2.5 3.6Q0 5.2 2.5 3.6" stroke={soft} strokeWidth="1.4" strokeLinecap="round" fill="none" />
        </>
      )
  }
}

function DeskChair2D({
  faceUp,
  empty,
  memberId,
  quotaNote,
}: {
  faceUp: boolean
  empty: boolean
  memberId: string
  quotaNote: string | null
}) {
  const backY = faceUp ? 54 : 3
  const seatY = faceUp ? 45 : 20
  return (
    <g data-testid={empty ? `empty-chair-${memberId}` : `chair-${memberId}`}>
      {/* Chair stem & base */}
      <rect x="57" y={faceUp ? "68" : "26"} width="6" height="6" rx="1.5" fill="var(--color-line)" />
      {/* Chair backrest */}
      <rect
        x="42"
        y={backY}
        width="36"
        height="18"
        rx="6"
        fill="var(--color-sidebar)"
        stroke="var(--color-line)"
        strokeWidth="1.3"
      />
      {/* Chair seat cushion & armrests */}
      <rect
        x="39"
        y={seatY}
        width="42"
        height="9"
        rx="4"
        fill="var(--color-surface)"
        stroke="var(--color-line)"
        strokeWidth="1.2"
      />
      {empty && quotaNote && (
        <g data-testid={`quota-note-${memberId}`}>
          <rect
            x="24"
            y={faceUp ? "52" : "8"}
            width="72"
            height="14"
            rx="5"
            fill="var(--color-surface)"
            stroke="var(--color-danger)"
            strokeWidth="1.1"
          />
          <text
            x="60"
            y={faceUp ? "61.5" : "17.5"}
            textAnchor="middle"
            fontSize="7.5"
            fontFamily="monospace"
            fontWeight="600"
            fill="var(--color-danger)"
          >
            {quotaNote}
          </text>
        </g>
      )}
    </g>
  )
}

function SeatedCharacter2D({
  view,
  memberId,
  hue,
  busyForHandle,
  glanceDelay,
}: {
  view: Character2DView
  memberId: string
  hue: { accent: string; soft: string }
  busyForHandle: string | undefined
  glanceDelay: number
}) {
  const {
    figure,
    identity,
    pose,
    headCenter,
    torsoRect,
    leftShoulder,
    rightShoulder,
    leftHand,
    rightHand,
    eyesClosed,
    idleGlance,
  } = view
  const animate = pose.animated
  const isHuman = figure === "human"

  return (
    <g data-testid={`character-${memberId}`} data-figure={figure} data-pose={pose.pose}>
      {busyForHandle && (
        <rect
          data-testid={`busy-ring-${memberId}`}
          x="39"
          y={view.facing === "up" ? "38" : "1"}
          width="42"
          height="39"
          rx="19"
          fill="none"
          stroke={hue.accent}
          strokeOpacity="0.38"
          strokeWidth="1.5"
        />
      )}

      {/* Seated torso (human clothes with collar/lapel for the Director, robot torso for agents) */}
      {isHuman ? (
        <g data-testid={`human-clothes-${memberId}`}>
          {/* Neck */}
          <rect
            x="57.5"
            y={torsoRect.y - 3.5}
            width="5"
            height="5"
            rx="2"
            fill={hue.soft}
            stroke={hue.accent}
            strokeWidth="1.1"
          />
          {/* Rounded shoulders and jacket */}
          <path
            d={`M${torsoRect.x} ${torsoRect.y + torsoRect.h}V${torsoRect.y + 6}C${torsoRect.x} ${torsoRect.y + 1.5} ${torsoRect.x + 4} ${torsoRect.y} ${torsoRect.x + 8} ${torsoRect.y}H${torsoRect.x + torsoRect.w - 8}C${torsoRect.x + torsoRect.w - 4} ${torsoRect.y} ${torsoRect.x + torsoRect.w} ${torsoRect.y + 1.5} ${torsoRect.x + torsoRect.w} ${torsoRect.y + 6}V${torsoRect.y + torsoRect.h}Z`}
            fill={hue.accent}
          />
          {/* Shirt V-collar and lapel */}
          <path
            d={`M55.5 ${torsoRect.y + 0.5}L60 ${torsoRect.y + 7.5}L64.5 ${torsoRect.y + 0.5}Z`}
            fill="var(--color-surface)"
          />
          <path
            d={`M55.5 ${torsoRect.y + 0.8}L60 ${torsoRect.y + 7.5}L64.5 ${torsoRect.y + 0.8}M60 ${torsoRect.y + 7.5}V${torsoRect.y + torsoRect.h - 1.5}`}
            stroke={hue.soft}
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </g>
      ) : (
        <>
          <rect
            x={torsoRect.x}
            y={torsoRect.y}
            width={torsoRect.w}
            height={torsoRect.h}
            rx="6"
            fill={hue.accent}
          />
          <path
            d={`M${torsoRect.x + 8} ${torsoRect.y + 1.5}H${torsoRect.x + torsoRect.w - 8}`}
            stroke={hue.soft}
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </>
      )}

      {/* Persona role chest pin */}
      {identity.pinMotif && (
        <g
          data-testid={`role-pin-${memberId}`}
          data-motif={identity.pinMotif}
          transform={`translate(${torsoRect.x + torsoRect.w - 6} ${torsoRect.y + 7.5})`}
        >
          <circle r="4.6" fill={hue.soft} stroke={hue.accent} strokeWidth="1" />
          <MotifGlyph motif={identity.pinMotif} cx={0} cy={0} color={hue.accent} scale={0.78} />
        </g>
      )}

      {/* Non-typing arm poses (rest, raised, stretch, slumped) */}
      {pose.pose !== "working" && (
        <g
          data-testid={
            pose.pose === "done_recently"
              ? `stretch-pose-${memberId}`
              : pose.pose === "failed"
                ? `slumped-pose-${memberId}`
                : `arms-${memberId}`
          }
        >
          <path
            d={`M${leftShoulder.x} ${leftShoulder.y}L${leftHand.x} ${leftHand.y}`}
            stroke={hue.accent}
            strokeWidth="3.8"
            strokeLinecap="round"
          />
          <circle
            cx={leftHand.x}
            cy={leftHand.y}
            r="2.8"
            fill={isHuman ? hue.soft : hue.accent}
            stroke={isHuman ? hue.accent : hue.soft}
            strokeWidth="1.1"
          />

          <motion.g
            data-testid={pose.rightArm === "raised" ? `raised-arm-${memberId}` : undefined}
            animate={pose.rightArm === "raised" && animate ? { y: [0, -2, 0] } : undefined}
            transition={
              pose.rightArm === "raised" && animate
                ? { duration: 1.1, repeat: Infinity, ease: "easeInOut" }
                : undefined
            }
          >
            <path
              d={`M${rightShoulder.x} ${rightShoulder.y}L${rightHand.x} ${rightHand.y}`}
              stroke={hue.accent}
              strokeWidth="3.8"
              strokeLinecap="round"
            />
            <circle
              cx={rightHand.x}
              cy={rightHand.y}
              r="2.8"
              fill={isHuman ? hue.soft : hue.accent}
              stroke={isHuman ? hue.accent : hue.soft}
              strokeWidth="1.1"
            />
          </motion.g>
        </g>
      )}

      {/* Character head derived from AgentAvatar silhouettes (or friendly human head for the Director) */}
      <g transform={`translate(${headCenter.x} ${headCenter.y})`}>
        <motion.g
          data-testid={`desk-avatar-${memberId}`}
          data-glance={idleGlance ? "true" : "false"}
          data-silhouette={identity.headSilhouette}
          animate={idleGlance ? { x: [0, 0, -2, 2, 0, 0] } : undefined}
          transition={
            idleGlance
              ? {
                  duration: 5.2,
                  delay: glanceDelay,
                  repeat: Infinity,
                  ease: "easeInOut",
                  times: [0, 0.68, 0.76, 0.86, 0.94, 1],
                }
              : undefined
          }
        >
          <CharacterHead2D
            silhouette={identity.headSilhouette}
            accent={hue.accent}
            soft={hue.soft}
            closed={eyesClosed}
          />
        </motion.g>
      </g>
    </g>
  )
}

// One compact desk of the room, drawn in a 120x108 box at (x, y). Each agent
// is drawn as a 2D flat character sitting at its desk (or an empty chair with
// a reset note when out of quota), matching the 3D office poses.
export function RoomDesk({
  desk,
  x,
  y,
  scale,
  facing = "down",
  lastMessageAt,
  now,
  selected,
  reducedMotion,
  onSelect,
  onOpenApproval,
}: OfficeDeskProps & {
  x: number
  y: number
  scale: number
  facing?: "up" | "down"
  lastMessageAt?: number | string | undefined
  now?: number | undefined
}) {
  const { member, state: deskState, outOfQuota, elapsedText, runTitle } = desk
  const hue = hueVars(desk)
  const view = derive2DCharacterView(desk, { reducedMotion, facing, lastMessageAt, now })
  const { figure, initials, identity, pose } = view
  const state: DeskState = pose.pose === "working" ? "working" : deskState
  const stateLabel = state === "working" ? "working" : desk.stateLabel
  const isHuman = figure === "human"
  const dimmed = state === "out_of_quota" || outOfQuota
  const animate = pose.animated
  const screenStroke =
    pose.monitorMode === "glow" || pose.monitorMode === "persona_badge"
      ? hue.accent
      : (SCREEN_STROKE[state] ?? "var(--color-line)")
  const lineStroke =
    pose.monitorMode === "glow" ? hue.accent : (SCREEN_STROKE[state] ?? "var(--color-faint)")
  const lit =
    pose.monitorMode === "glow" ||
    pose.monitorMode === "approval" ||
    pose.monitorMode === "error" ||
    pose.monitorMode === "persona_badge"
  const faceUp = facing === "up"
  const glanceDelay = (seedFromId(member.id) % 7) * 0.45

  const ariaParts = [member.display_name, stateLabel]
  if (state === "working" && elapsedText) ariaParts.push(`elapsed ${elapsedText}`)
  if (dimmed && state !== "out_of_quota") ariaParts.push("out of quota")
  const busyFor = desk.busyFor
  if (busyFor) ariaParts.push(`busy for @${busyFor.handle}`)
  const baseHover = busyFor
    ? `${member.display_name} - busy for @${busyFor.handle}`
    : state === "working" && elapsedText
      ? `${member.display_name} - working (${elapsedText})`
      : `${member.display_name} - ${stateLabel}`
  const hoverTitle = runTitle ? `${baseHover}: ${runTitle}` : baseHover

  function handleApprovalClick(event: MouseEvent<SVGGElement>) {
    event.stopPropagation()
    onOpenApproval(desk)
  }

  function handleKeyDown(event: KeyboardEvent<SVGGElement>) {
    if (event.key !== "Enter" && event.key !== " ") return
    event.preventDefault()
    onSelect(desk)
  }

  const deskElement = (
    <g opacity={dimmed ? 0.65 : 1}>
      {/* A front lip gives the slight 3/4 view; when facing up (Director), the desk sits near the top and faces into the room. */}
      <rect x="10" y={faceUp ? "14" : "36"} width="104" height="36" rx="8" fill="var(--color-ink)" fillOpacity="0.07" />
      <rect x="8" y={faceUp ? "16" : "38"} width="104" height="34" rx="8" fill="var(--color-sidebar)" stroke="var(--color-line)" />
      <rect x="8" y={faceUp ? "10" : "32"} width="104" height="34" rx="8" fill="var(--color-surface)" stroke="var(--color-line)" />
      <path d={faceUp ? "M22 41.5H98" : "M22 34.5H98"} stroke={hue.accent} strokeWidth="2.5" strokeLinecap="round" />
      <rect x="16" y={faceUp ? "18" : "42"} width="14" height="16" rx="2.5" fill="var(--color-canvas)" stroke="var(--color-line)" />
      {isHuman ? (
        <g data-testid={`nameplate-${member.id}`}>
          <rect
            x="88"
            y={faceUp ? "19" : "43"}
            width="20"
            height="12"
            rx="3"
            fill={hue.soft}
            stroke={hue.accent}
            strokeWidth="1.2"
          />
          <text
            x="98"
            y={faceUp ? "27.5" : "51.5"}
            textAnchor="middle"
            fontSize="7.5"
            fontFamily="monospace"
            fontWeight="700"
            fill={hue.accent}
          >
            {initials}
          </text>
        </g>
      ) : (
        <circle cx="98" cy={faceUp ? "26" : "50"} r="5" fill={hue.soft} stroke={hue.accent} strokeWidth="1.2" />
      )}

      {pose.monitorMode === "glow" && (
        <motion.ellipse
          data-testid={`monitor-glow-${member.id}`}
          cx="60"
          cy={faceUp ? 26 : 50}
          rx="36"
          ry="16"
          fill={hue.accent}
          fillOpacity={0.18}
          animate={animate ? { fillOpacity: [0.1, 0.26, 0.1] } : undefined}
          transition={animate ? { duration: 1.6, repeat: Infinity, ease: "easeInOut" } : undefined}
        />
      )}

      {/* Failed state: red desk lamp with soft red pool on the desk corner */}
      {pose.showRedLamp && (
        <g data-testid={`red-lamp-${member.id}`}>
          <ellipse
            cx="94"
            cy={faceUp ? "26" : "49"}
            rx="14"
            ry="8"
            fill="var(--color-danger)"
            fillOpacity="0.22"
          />
          <rect x="93" y={faceUp ? "27" : "50"} width="8" height="2.5" rx="1" fill="var(--color-line)" />
          <path
            d={faceUp ? "M97 27L99 17L92 15" : "M97 50L99 40L92 38"}
            stroke="var(--color-faint)"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
          <path
            d={faceUp ? "M88 18L94 12L96 19Z" : "M88 41L94 35L96 42Z"}
            fill="var(--color-danger)"
          />
        </g>
      )}

      <rect x="56" y={faceUp ? "32" : "54"} width="8" height="3" fill="var(--color-line)" />
      <rect
        x="44"
        y={faceUp ? "17" : "39"}
        width="32"
        height="16"
        rx="3.5"
        fill={pose.monitorMode === "persona_badge" ? hue.soft : "var(--color-code)"}
        stroke={screenStroke}
        strokeWidth={lit ? 1.6 : 1.2}
      />

      {pose.monitorMode === "glow" ? (
        <g data-testid={`monitor-lines-${member.id}`}>
          <motion.path
            d={faceUp ? "M49 22H66" : "M49 44H66"}
            stroke={lineStroke}
            strokeWidth="1.8"
            strokeLinecap="round"
            animate={animate ? { opacity: [0.4, 1, 0.4] } : undefined}
            transition={animate ? { duration: 1.1, repeat: Infinity, ease: "easeInOut" } : undefined}
          />
          <path d={faceUp ? "M49 27H60" : "M49 49H60"} stroke="var(--color-muted)" strokeWidth="1.5" strokeLinecap="round" />
        </g>
      ) : pose.monitorMode === "persona_badge" && pose.personaBadgeMotif ? (
        <g
          data-testid={`monitor-persona-badge-${member.id}`}
          data-motif={pose.personaBadgeMotif}
          data-persona-role={pose.personaBadgeRole ?? undefined}
        >
          <MotifGlyph
            motif={pose.personaBadgeMotif}
            cx={60}
            cy={faceUp ? 25 : 47}
            color={hue.accent}
            scale={1.25}
          />
        </g>
      ) : pose.monitorMode === "clock" ? (
        <g data-testid={`monitor-clock-${member.id}`} transform={`translate(60 ${faceUp ? 25 : 47})`}>
          <circle r="4.5" fill="none" stroke="var(--color-muted)" strokeWidth="1.2" />
          <path d="M0 -2.5V0L1.8 1.2" stroke="var(--color-muted)" strokeWidth="1.2" strokeLinecap="round" fill="none" />
        </g>
      ) : (
        <g strokeLinecap="round" strokeWidth="1.5" stroke={lineStroke} strokeOpacity={pose.monitorMode === "off" ? 0.25 : 0.6}>
          <path d={faceUp ? "M49 22H68" : "M49 44H68"} />
          <path d={faceUp ? "M49 27H60" : "M49 49H60"} />
        </g>
      )}
      <rect x="47" y={faceUp ? "35" : "59"} width="26" height="5" rx="2" fill="var(--color-canvas)" stroke="var(--color-line)" />

      {/* Small progress pulse on the desk front while running. */}
      {state === "working" && (
        <g data-testid={`progress-pulse-${member.id}`} data-animated={animate ? "true" : "false"}>
          <rect x="34" y={faceUp ? "12" : "66"} width="52" height="3" rx="1.5" fill={hue.soft} />
          <motion.rect
            x="34"
            y={faceUp ? "12" : "66"}
            width="22"
            height="3"
            rx="1.5"
            fill={hue.accent}
            animate={animate ? { x: [34, 64, 34], opacity: [0.65, 1, 0.65] } : undefined}
            transition={animate ? { duration: 1.5, repeat: Infinity, ease: "easeInOut" } : undefined}
          />
        </g>
      )}
    </g>
  )

  return (
    <g transform={`translate(${x} ${y}) scale(${scale})`}>
      <g
        role="button"
        tabIndex={0}
        aria-label={ariaParts.join(", ")}
        aria-pressed={selected}
        data-testid={`desk-${member.id}`}
        data-figure={figure}
        data-state={state}
        data-pose={pose.pose}
        data-cli={identity.cli}
        data-head={identity.headSilhouette}
        data-role-pin={identity.rolePin ?? undefined}
        data-seated={view.seated ? "true" : "false"}
        data-monitor-mode={pose.monitorMode}
        data-busy-for={busyFor?.handle}
        data-director={desk.isDirector ? "true" : "false"}
        data-facing={facing}
        data-out-of-quota={dimmed ? "true" : "false"}
        onClick={() => onSelect(desk)}
        onKeyDown={handleKeyDown}
        className="group cursor-pointer outline-none"
      >
        <title>{hoverTitle}</title>
        <rect width={DESK_W} height={DESK_H} fill="transparent" />
        <rect
          x="1"
          y="1"
          width={DESK_W - 2}
          height={DESK_H - 2}
          rx="12"
          fill="none"
          stroke="var(--color-accent)"
          strokeWidth="2"
          className="opacity-0 group-focus-visible:opacity-100"
        />
        {selected && (
          <rect
            x="1"
            y="1"
            width={DESK_W - 2}
            height={DESK_H - 2}
            rx="12"
            fill="var(--color-accent-soft)"
            fillOpacity="0.5"
            stroke="var(--color-accent)"
            strokeWidth="1.5"
          />
        )}

        <g className="transition-transform duration-150 ease-out group-hover:-translate-y-[3px] motion-reduce:transition-none">
          {faceUp ? (
            <>
              {deskElement}
              <DeskChair2D
                faceUp={faceUp}
                empty={!view.seated}
                memberId={member.id}
                quotaNote={pose.quotaNote}
              />
              {view.seated && (
                <SeatedCharacter2D
                  view={view}
                  memberId={member.id}
                  hue={hue}
                  busyForHandle={busyFor?.handle}
                  glanceDelay={glanceDelay}
                />
              )}
            </>
          ) : (
            <>
              <DeskChair2D
                faceUp={faceUp}
                empty={!view.seated}
                memberId={member.id}
                quotaNote={pose.quotaNote}
              />
              {view.seated && (
                <SeatedCharacter2D
                  view={view}
                  memberId={member.id}
                  hue={hue}
                  busyForHandle={busyFor?.handle}
                  glanceDelay={glanceDelay}
                />
              )}
              {deskElement}
            </>
          )}

          {state === "working" && (
            <g data-testid={`typing-hands-${member.id}`} data-animated={animate ? "true" : "false"}>
              <path
                d={`M${view.leftShoulder.x} ${view.leftShoulder.y}L${view.leftHand.x} ${view.leftHand.y}`}
                stroke={hue.accent}
                strokeWidth="3.4"
                strokeLinecap="round"
                strokeOpacity="0.85"
              />
              <path
                d={`M${view.rightShoulder.x} ${view.rightShoulder.y}L${view.rightHand.x} ${view.rightHand.y}`}
                stroke={hue.accent}
                strokeWidth="3.4"
                strokeLinecap="round"
                strokeOpacity="0.85"
              />
              <motion.circle
                cx={view.leftHand.x}
                cy={view.leftHand.y}
                r="3"
                fill={isHuman ? hue.soft : hue.accent}
                stroke={isHuman ? hue.accent : undefined}
                strokeWidth={isHuman ? "1.1" : undefined}
                animate={animate ? { y: [0, -2.5, 0] } : undefined}
                transition={animate ? { duration: 0.34, repeat: Infinity, ease: "easeInOut" } : undefined}
              />
              <motion.circle
                cx={view.rightHand.x}
                cy={view.rightHand.y}
                r="3"
                fill={isHuman ? hue.soft : hue.accent}
                stroke={isHuman ? hue.accent : undefined}
                strokeWidth={isHuman ? "1.1" : undefined}
                animate={animate ? { y: [-2.5, 0, -2.5] } : undefined}
                transition={animate ? { duration: 0.34, repeat: Infinity, ease: "easeInOut" } : undefined}
              />
            </g>
          )}

          {state === "working" && elapsedText && (
            <g data-testid={`elapsed-${member.id}`}>
              <rect x="80" y="3" width="38" height="14" rx="7" fill={hue.soft} stroke={hue.accent} strokeOpacity="0.5" />
              <text x="99" y="13" textAnchor="middle" fontSize="8.5" fontFamily="monospace" fill={hue.accent}>
                {elapsedText}
              </text>
            </g>
          )}

          {state === "queued" && (
            <g data-testid={`clock-badge-${member.id}`} transform="translate(90 12)">
              <circle r="8.5" fill="var(--color-surface)" stroke="var(--color-line)" strokeWidth="1.4" />
              <circle r="5" fill="none" stroke="var(--color-muted)" strokeWidth="1.2" />
              <path d="M0 -3V0L2 1.3" stroke="var(--color-muted)" strokeWidth="1.2" strokeLinecap="round" fill="none" />
            </g>
          )}

          {/* Waiting for approval: raised hand + small floating card above the desk */}
          {pose.showApprovalCard && (
            <g
              data-testid={`approval-card-${member.id}`}
              onClick={handleApprovalClick}
              className="cursor-pointer"
            >
              <g data-testid={`raised-hand-badge-${member.id}`}>
                <rect
                  x="76"
                  y="2"
                  width="42"
                  height="16"
                  rx="5"
                  fill="var(--color-warn-soft)"
                  stroke="var(--color-warn)"
                  strokeWidth="1.3"
                />
                <path
                  d="M82 12V8.5M83.5 12V7.8M85 12V8.2M86.5 12V9"
                  stroke="var(--color-warn)"
                  strokeWidth="1.1"
                  strokeLinecap="round"
                />
                <text
                  x="101"
                  y="12.5"
                  textAnchor="middle"
                  fontSize="7.5"
                  fontWeight="600"
                  fill="var(--color-warn)"
                >
                  Approve
                </text>
              </g>
            </g>
          )}

          {state === "failed" && (
            <g data-testid={`danger-badge-${member.id}`} transform="translate(90 12)">
              <rect x="-8.5" y="-8.5" width="17" height="17" rx="4" fill="var(--color-danger-soft)" stroke="var(--color-danger)" strokeWidth="1.4" />
              <path d="M-3 -3L3 3M3 -3L-3 3" stroke="var(--color-danger)" strokeWidth="1.5" strokeLinecap="round" />
            </g>
          )}

          {runTitle && (
            <g
              data-testid={`run-title-${member.id}`}
              className="pointer-events-none opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transition-none"
            >
              <rect
                x="4"
                y="90"
                width="112"
                height="16"
                rx="6"
                fill="var(--color-surface)"
                stroke="var(--color-line)"
              />
              <text x="60" y="101" textAnchor="middle" fontSize="8.5" fill="var(--color-muted)">
                {clip(runTitle, 24)}
              </text>
            </g>
          )}
        </g>

        <text x="60" y="86" textAnchor="middle" fontSize="11" fontWeight="600" fill="var(--color-ink)">
          {clip(member.display_name, 16)}
        </text>
        {dimmed && (
          <g data-testid={`quota-tag-${member.id}`} className={runTitle ? "group-hover:opacity-0" : undefined}>
            <rect x="24" y="91" width="72" height="13" rx="6.5" fill="var(--color-danger-soft)" stroke="var(--color-danger)" strokeOpacity="0.5" />
            <text x="60" y="100.5" textAnchor="middle" fontSize="8" fontWeight="600" fill="var(--color-danger)">
              {pose.quotaNote ?? "out of quota"}
            </text>
          </g>
        )}
      </g>
    </g>
  )
}


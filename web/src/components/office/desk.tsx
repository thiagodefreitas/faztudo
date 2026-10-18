import { motion } from "motion/react"
import type { KeyboardEvent, MouseEvent } from "react"
import { identityOf } from "../../lib/avatar"
import { cx } from "../../lib/cx"
import { AgentAvatar } from "../agent-avatar"
import { avatarState } from "./avatar"
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

// One compact desk of the room, drawn in a 120x108 box at (x, y). The avatar
// sits above the desk edge and the name under the desk.
export function RoomDesk({
  desk,
  x,
  y,
  scale,
  selected,
  reducedMotion,
  onSelect,
  onOpenApproval,
}: OfficeDeskProps & { x: number; y: number; scale: number }) {
  const { member, state, stateLabel, outOfQuota, elapsedText } = desk
  const hue = hueVars(desk)
  const dimmed = state === "out_of_quota" || outOfQuota
  const animate = state === "working" && !reducedMotion
  const screenStroke = state === "working" ? hue.accent : (SCREEN_STROKE[state] ?? "var(--color-line)")
  const lineStroke = state === "working" ? hue.accent : (SCREEN_STROKE[state] ?? "var(--color-faint)")
  const lit = state === "working" || state === "waiting_approval" || state === "failed"

  const ariaParts = [member.display_name, stateLabel]
  if (state === "working" && elapsedText) ariaParts.push(`elapsed ${elapsedText}`)
  if (dimmed && state !== "out_of_quota") ariaParts.push("out of quota")
  const hoverTitle =
    state === "working" && elapsedText
      ? `${member.display_name} - working (${elapsedText})`
      : `${member.display_name} - ${stateLabel}`

  function handleApprovalClick(event: MouseEvent<SVGGElement>) {
    event.stopPropagation()
    onOpenApproval(desk)
  }

  function handleKeyDown(event: KeyboardEvent<SVGGElement>) {
    if (event.key !== "Enter" && event.key !== " ") return
    event.preventDefault()
    onSelect(desk)
  }

  return (
    <g transform={`translate(${x} ${y}) scale(${scale})`}>
      <g
        role="button"
        tabIndex={0}
        aria-label={ariaParts.join(", ")}
        aria-pressed={selected}
        data-testid={`desk-${member.id}`}
        data-state={state}
        data-director={desk.isDirector ? "true" : "false"}
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
          <g opacity={dimmed ? 0.5 : 1}>
            {/* A front lip under the top gives the slight 3/4 view. */}
            <rect x="10" y="36" width="104" height="36" rx="8" fill="var(--color-ink)" fillOpacity="0.07" />
            <rect x="8" y="38" width="104" height="34" rx="8" fill="var(--color-sidebar)" stroke="var(--color-line)" />
            <rect x="8" y="32" width="104" height="34" rx="8" fill="var(--color-surface)" stroke="var(--color-line)" />
            <path d="M22 34.5H98" stroke={hue.accent} strokeWidth="2.5" strokeLinecap="round" />
            <rect x="16" y="42" width="14" height="16" rx="2.5" fill="var(--color-canvas)" stroke="var(--color-line)" />
            <circle cx="98" cy="50" r="5" fill={hue.soft} stroke={hue.accent} strokeWidth="1.2" />

            {state === "working" && (
              <motion.ellipse
                data-testid={`monitor-glow-${member.id}`}
                cx="60"
                cy="50"
                rx="36"
                ry="16"
                fill={hue.accent}
                fillOpacity={0.18}
                animate={animate ? { fillOpacity: [0.1, 0.26, 0.1] } : undefined}
                transition={animate ? { duration: 1.6, repeat: Infinity, ease: "easeInOut" } : undefined}
              />
            )}

            <rect x="56" y="54" width="8" height="3" fill="var(--color-line)" />
            <rect
              x="44"
              y="39"
              width="32"
              height="16"
              rx="3.5"
              fill="var(--color-code)"
              stroke={screenStroke}
              strokeWidth={lit ? 1.6 : 1.2}
            />
            {state === "working" ? (
              <g data-testid={`monitor-lines-${member.id}`}>
                <motion.path
                  d="M49 44H66"
                  stroke={lineStroke}
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  animate={animate ? { opacity: [0.4, 1, 0.4] } : undefined}
                  transition={animate ? { duration: 1.1, repeat: Infinity, ease: "easeInOut" } : undefined}
                />
                <path d="M49 49H60" stroke="var(--color-muted)" strokeWidth="1.5" strokeLinecap="round" />
              </g>
            ) : (
              <g strokeLinecap="round" strokeWidth="1.5" stroke={lineStroke} strokeOpacity="0.6">
                <path d="M49 44H68" />
                <path d="M49 49H60" />
              </g>
            )}
            <rect x="47" y="59" width="26" height="5" rx="2" fill="var(--color-canvas)" stroke="var(--color-line)" />
          </g>

          <foreignObject x="42" y="2" width="36" height="36">
            <div style={{ width: 36, height: 36 }} className="flex items-center justify-center">
              <AgentAvatar member={member} size={36} state={avatarState(state)} decorative className="h-full w-full" />
            </div>
          </foreignObject>

          {state === "working" && (
            <g data-testid={`typing-hands-${member.id}`} data-animated={animate ? "true" : "false"}>
              <motion.circle
                cx="52"
                cy="58"
                r="3"
                fill={hue.accent}
                animate={animate ? { y: [0, -2.5, 0] } : undefined}
                transition={animate ? { duration: 0.34, repeat: Infinity, ease: "easeInOut" } : undefined}
              />
              <motion.circle
                cx="68"
                cy="58"
                r="3"
                fill={hue.accent}
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

          {state === "waiting_approval" && (
            <g
              data-testid={`raised-hand-badge-${member.id}`}
              transform="translate(90 12)"
              onClick={handleApprovalClick}
              className="cursor-pointer"
            >
              <circle r="10" fill="var(--color-warn-soft)" stroke="var(--color-warn)" strokeWidth="1.5" />
              <path
                d="M-2.8 2.4V-2.2M-0.9 2.4V-3.2M1 2.4V-2.7M2.9 2.4V-1.4M-2.8 2.4C-2.8 4.2 2.9 4.2 2.9 2.4"
                stroke="var(--color-warn)"
                strokeWidth="1.2"
                strokeLinecap="round"
                fill="none"
              />
            </g>
          )}

          {state === "failed" && (
            <g data-testid={`danger-badge-${member.id}`} transform="translate(90 12)">
              <rect x="-8.5" y="-8.5" width="17" height="17" rx="4" fill="var(--color-danger-soft)" stroke="var(--color-danger)" strokeWidth="1.4" />
              <path d="M-3 -3L3 3M3 -3L-3 3" stroke="var(--color-danger)" strokeWidth="1.5" strokeLinecap="round" />
            </g>
          )}
        </g>

        <text x="60" y="86" textAnchor="middle" fontSize="11" fontWeight="600" fill="var(--color-ink)">
          {clip(member.display_name, 16)}
        </text>
        {dimmed && (
          <g data-testid={`quota-tag-${member.id}`}>
            <rect x="32" y="91" width="56" height="13" rx="6.5" fill="var(--color-danger-soft)" stroke="var(--color-danger)" strokeOpacity="0.5" />
            <text x="60" y="100.5" textAnchor="middle" fontSize="8" fontWeight="600" fill="var(--color-danger)">
              out of quota
            </text>
          </g>
        )}
      </g>
    </g>
  )
}

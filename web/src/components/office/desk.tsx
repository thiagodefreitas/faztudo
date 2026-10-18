import { motion } from "motion/react"
import type { MouseEvent } from "react"
import { cx } from "../../lib/cx"
import { AgentAvatar } from "../agent-avatar"
import { avatarState } from "./avatar"
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

export function OfficeDesk({
  desk,
  selected,
  reducedMotion,
  onSelect,
  onOpenApproval,
}: OfficeDeskProps) {
  const { member, isDirector, state, stateLabel, palette, monogram, laneId, outOfQuota, elapsedText } = desk
  const dimmed = state === "out_of_quota" || outOfQuota
  const animateWorking = state === "working" && !reducedMotion

  const width = isDirector ? 260 : 220
  const height = isDirector ? 148 : 136
  const cxPos = width / 2
  const deskX = isDirector ? 22 : 20
  const deskY = 18
  const deskW = width - deskX * 2
  const deskH = isDirector ? 66 : 60
  const monitorW = isDirector ? 74 : 56
  const monitorH = isDirector ? 26 : 22
  const monitorX = cxPos - monitorW / 2
  const monitorY = deskY + 8
  const avatarY = deskY + deskH + 22
  const avatarR = isDirector ? 20 : 17
  const chairW = avatarR * 2.35
  const chairH = avatarR * 1.1
  const handOffset = avatarR * 0.72
  const handY = avatarY - avatarR - 4

  const ariaParts = [member.display_name, stateLabel]
  if (state === "working" && elapsedText) ariaParts.push(`elapsed ${elapsedText}`)
  if (dimmed && state !== "out_of_quota") ariaParts.push("out of quota")
  const ariaLabel = ariaParts.join(", ")

  const hoverTitle =
    state === "working" && elapsedText
      ? `${member.display_name} - working (${elapsedText})`
      : `${member.display_name} - ${stateLabel}`

  function handleApprovalClick(event: MouseEvent<HTMLElement | SVGGElement>) {
    event.stopPropagation()
    onOpenApproval(desk)
  }

  return (
    <button
      type="button"
      aria-label={ariaLabel}
      aria-pressed={selected}
      title={hoverTitle}
      data-testid={`desk-${member.id}`}
      data-state={state}
      data-director={isDirector ? "true" : "false"}
      data-out-of-quota={dimmed ? "true" : "false"}
      onClick={() => onSelect(desk)}
      className={cx(
        "group relative flex w-full flex-col rounded-xl border bg-surface/90 p-3 text-left transition-colors",
        selected ? "border-accent ring-2 ring-accent/35" : "border-line hover:border-accent/60",
        isDirector && "sm:max-w-md",
        dimmed && "opacity-65",
      )}
    >
      {/* Floating hover pill for working elapsed duration */}
      {state === "working" && elapsedText && (
        <span
          data-testid={`elapsed-${member.id}`}
          className="pointer-events-none absolute right-2.5 top-2.5 z-10 rounded-full border border-accent/40 bg-accent-soft px-2 py-0.5 font-mono text-[11px] font-medium tabular-nums text-accent opacity-90 shadow-xs transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
        >
          {elapsedText}
        </span>
      )}

      {/* Out of quota tag */}
      {dimmed && (
        <span
          data-testid={`quota-tag-${member.id}`}
          className=" absolute left-2.5 top-2.5 z-10 rounded-full border border-danger/40 bg-danger-soft px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-danger"
        >
          out of quota
        </span>
      )}

      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-auto w-full select-none overflow-visible"
        role="img"
        aria-hidden="true"
      >
        <title>{hoverTitle}</title>

        {/* Soft floor shadow under desk */}
        <rect
          x={deskX + 3}
          y={deskY + 5}
          width={deskW}
          height={deskH}
          rx="14"
          fill="var(--color-ink)"
          fillOpacity="0.06"
        />

        {/* Desk surface (flat isometric-lite top-down with front lip) */}
        <rect
          x={deskX}
          y={deskY}
          width={deskW}
          height={deskH}
          rx="13"
          fill="var(--color-surface)"
          stroke={selected ? "var(--color-accent)" : "var(--color-line)"}
          strokeWidth={selected ? "2" : "1.5"}
        />
        {/* Hue accent strip along the top edge of the desk */}
        <path
          d={`M ${deskX + 12} ${deskY + 1.5} H ${deskX + deskW - 12}`}
          stroke={palette.border}
          strokeWidth="3"
          strokeLinecap="round"
        />
        {/* Subtle front edge bevel */}
        <line
          x1={deskX + 10}
          y1={deskY + deskH - 5}
          x2={deskX + deskW - 10}
          y2={deskY + deskH - 5}
          stroke="var(--color-line)"
          strokeWidth="1"
          strokeOpacity="0.7"
        />

        {/* Desk accessories: notepad on left, mug/plant on right */}
        <rect
          x={deskX + 14}
          y={deskY + 18}
          width={isDirector ? 22 : 16}
          height={isDirector ? 26 : 20}
          rx="3"
          fill="var(--color-canvas)"
          stroke="var(--color-line)"
          strokeWidth="1"
        />
        <line
          x1={deskX + 18}
          y1={deskY + 24}
          x2={deskX + (isDirector ? 31 : 26)}
          y2={deskY + 24}
          stroke="var(--color-faint)"
          strokeWidth="1"
          strokeLinecap="round"
        />
        <line
          x1={deskX + 18}
          y1={deskY + 29}
          x2={deskX + (isDirector ? 29 : 24)}
          y2={deskY + 29}
          stroke="var(--color-faint)"
          strokeWidth="1"
          strokeLinecap="round"
        />

        {/* Small cup / plant on right side of desk */}
        <circle
          cx={deskX + deskW - 22}
          cy={deskY + 24}
          r={isDirector ? 7.5 : 6}
          fill={palette.bg}
          stroke={palette.border}
          strokeWidth="1.25"
        />
        <circle cx={deskX + deskW - 22} cy={deskY + 24} r={isDirector ? 3.5 : 2.8} fill={palette.accent} fillOpacity="0.55" />

        {/* Monitor glow when working */}
        {state === "working" && (
          <ellipse
            data-testid={`monitor-glow-${member.id}`}
            cx={cxPos}
            cy={monitorY + monitorH / 2 + 4}
            rx={monitorW * 0.78}
            ry={monitorH * 0.95}
            fill={palette.accent}
            fillOpacity={animateWorking ? "0.22" : "0.16"}
          />
        )}

        {/* Monitor stand */}
        <rect
          x={cxPos - 8}
          y={monitorY + monitorH}
          width="16"
          height="4"
          rx="1.5"
          fill="var(--color-line)"
        />

        {/* Monitor bezel and screen */}
        <rect
          x={monitorX}
          y={monitorY}
          width={monitorW}
          height={monitorH}
          rx="5"
          fill="var(--color-code)"
          stroke={
            state === "working"
              ? palette.accent
              : state === "waiting_approval"
                ? "var(--color-warn)"
                : state === "failed"
                  ? "var(--color-danger)"
                  : "var(--color-line)"
          }
          strokeWidth={state === "working" || state === "waiting_approval" || state === "failed" ? "1.75" : "1.25"}
        />

        {/* Monitor screen contents */}
        {state === "working" ? (
          <g data-testid={`monitor-lines-${member.id}`}>
            <motion.line
              x1={monitorX + 7}
              y1={monitorY + 7}
              x2={monitorX + monitorW * 0.62}
              y2={monitorY + 7}
              stroke={palette.accent}
              strokeWidth="2"
              strokeLinecap="round"
              animate={animateWorking ? { opacity: [0.45, 1, 0.45] } : undefined}
              transition={animateWorking ? { duration: 1.1, repeat: Infinity, ease: "easeInOut" } : undefined}
            />
            <motion.line
              x1={monitorX + 7}
              y1={monitorY + 12}
              x2={monitorX + monitorW * 0.82}
              y2={monitorY + 12}
              stroke="var(--color-accent)"
              strokeWidth="1.75"
              strokeLinecap="round"
              animate={animateWorking ? { opacity: [1, 0.35, 1] } : undefined}
              transition={animateWorking ? { duration: 0.9, repeat: Infinity, ease: "easeInOut" } : undefined}
            />
            <line
              x1={monitorX + 7}
              y1={monitorY + 17}
              x2={monitorX + monitorW * 0.48}
              y2={monitorY + 17}
              stroke="var(--color-muted)"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </g>
        ) : state === "waiting_approval" ? (
          <g>
            <line
              x1={monitorX + 8}
              y1={monitorY + 9}
              x2={monitorX + monitorW - 8}
              y2={monitorY + 9}
              stroke="var(--color-warn)"
              strokeWidth="2"
              strokeLinecap="round"
            />
            <line
              x1={monitorX + 8}
              y1={monitorY + 15}
              x2={monitorX + monitorW * 0.65}
              y2={monitorY + 15}
              stroke="var(--color-warn)"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeOpacity="0.7"
            />
          </g>
        ) : state === "failed" ? (
          <g>
            <line
              x1={monitorX + 8}
              y1={monitorY + 9}
              x2={monitorX + monitorW - 8}
              y2={monitorY + 9}
              stroke="var(--color-danger)"
              strokeWidth="2"
              strokeLinecap="round"
            />
            <line
              x1={monitorX + 8}
              y1={monitorY + 15}
              x2={monitorX + monitorW * 0.55}
              y2={monitorY + 15}
              stroke="var(--color-danger)"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeOpacity="0.75"
            />
          </g>
        ) : (
          <g>
            <line
              x1={monitorX + 8}
              y1={monitorY + 9}
              x2={monitorX + monitorW * 0.58}
              y2={monitorY + 9}
              stroke="var(--color-faint)"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeOpacity="0.55"
            />
            <line
              x1={monitorX + 8}
              y1={monitorY + 14}
              x2={monitorX + monitorW * 0.4}
              y2={monitorY + 14}
              stroke="var(--color-faint)"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeOpacity="0.35"
            />
          </g>
        )}

        {/* Keyboard on desk */}
        <rect
          x={cxPos - 18}
          y={monitorY + monitorH + 8}
          width="36"
          height="11"
          rx="3"
          fill="var(--color-canvas)"
          stroke="var(--color-line)"
          strokeWidth="1.1"
        />
        <line
          x1={cxPos - 13}
          y1={monitorY + monitorH + 12}
          x2={cxPos + 13}
          y2={monitorY + monitorH + 12}
          stroke="var(--color-faint)"
          strokeWidth="1.2"
          strokeDasharray="2 2"
        />
        <line
          x1={cxPos - 11}
          y1={monitorY + monitorH + 15.5}
          x2={cxPos + 11}
          y2={monitorY + monitorH + 15.5}
          stroke="var(--color-faint)"
          strokeWidth="1.2"
          strokeDasharray="3 2"
        />

        {/* Ergonomic chair back behind avatar */}
        <rect
          x={cxPos - chairW / 2}
          y={avatarY + avatarR * 0.28}
          width={chairW}
          height={chairH}
          rx={chairH / 2}
          fill="var(--color-canvas)"
          stroke="var(--color-line)"
          strokeWidth="1.5"
        />

        {/* Typing hands when working */}
        {state === "working" &&
          (animateWorking ? (
            <g data-testid={`typing-hands-${member.id}`} data-animated="true">
              <motion.circle
                cx={cxPos - handOffset}
                cy={handY}
                r={3.5}
                fill={palette.accent}
                animate={{ y: [0, -2.5, 0] }}
                transition={{ duration: 0.34, repeat: Infinity, ease: "easeInOut" }}
              />
              <motion.circle
                cx={cxPos + handOffset}
                cy={handY}
                r={3.5}
                fill={palette.accent}
                animate={{ y: [-2.5, 0, -2.5] }}
                transition={{ duration: 0.34, repeat: Infinity, ease: "easeInOut" }}
              />
            </g>
          ) : (
            <g data-testid={`typing-hands-${member.id}`} data-animated="false">
              <circle cx={cxPos - handOffset} cy={handY} r={3.5} fill={palette.accent} />
              <circle cx={cxPos + handOffset} cy={handY} r={3.5} fill={palette.accent} />
            </g>
          ))}

        {/* Avatar disc */}
        {/* The same avatar as in the chat, scaled to the desk. */}
        {/* The same avatar as in the chat. foreignObject, because a human
            avatar is HTML and would not render as a child of an SVG. */}
        <foreignObject x={cxPos - avatarR} y={avatarY - avatarR} width={avatarR * 2} height={avatarR * 2}>
          <div style={{ width: avatarR * 2, height: avatarR * 2 }} className="flex items-center justify-center">
            <AgentAvatar member={member} size={36} state={avatarState(state)} decorative className="h-full w-full" />
          </div>
        </foreignObject>

        {/* State corner badges on SVG */}
        {state === "queued" && (
          <g
            data-testid={`clock-badge-${member.id}`}
            transform={`translate(${cxPos + avatarR + 8}, ${avatarY - avatarR + 2})`}
          >
            <circle cx="0" cy="0" r="8.5" fill="var(--color-surface)" stroke="var(--color-line)" strokeWidth="1.4" />
            <circle cx="0" cy="0" r="5.2" fill="none" stroke="var(--color-muted)" strokeWidth="1.2" />
            <path d="M0 -3V0L2 1.3" stroke="var(--color-muted)" strokeWidth="1.2" strokeLinecap="round" fill="none" />
          </g>
        )}

        {state === "waiting_approval" && (
          <g
            data-testid={`raised-hand-badge-${member.id}`}
            transform={`translate(${cxPos + avatarR + 9}, ${avatarY - avatarR + 1})`}
            onClick={handleApprovalClick}
            className="cursor-pointer"
          >
            <circle cx="0" cy="0" r="9.5" fill="var(--color-warn-soft)" stroke="var(--color-warn)" strokeWidth="1.5" />
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
          <g
            data-testid={`danger-badge-${member.id}`}
            transform={`translate(${cxPos + avatarR + 8}, ${avatarY - avatarR + 2})`}
          >
            <rect
              x="-8.5"
              y="-8.5"
              width="17"
              height="17"
              rx="4"
              fill="var(--color-danger-soft)"
              stroke="var(--color-danger)"
              strokeWidth="1.4"
            />
            <path
              d="M-3 -3L3 3M3 -3L-3 3"
              stroke="var(--color-danger)"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </g>
        )}
      </svg>

      {/* Nameplate and state row */}
      <div className="mt-1 flex w-full items-center justify-between gap-2 border-t border-line/70 pt-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[13px] font-semibold text-ink">{member.display_name}</span>
            {isDirector ? (
              <span className="rounded bg-accent-soft px-1.5 py-0.2 text-[10px] font-semibold uppercase tracking-wide text-accent">
                Director
              </span>
            ) : (
              <span
                style={{ backgroundColor: palette.bg, color: palette.fg, borderColor: palette.border }}
                className="rounded border px-1 font-mono text-[10px] font-semibold"
              >
                {monogram}
              </span>
            )}
          </div>
          <p className="truncate font-mono text-[11px] text-faint">
            @{member.handle}
            {laneId ? ` - ${laneId}` : ""}
          </p>
        </div>

        <DeskStateBadge
          state={state}
          testId={`state-badge-${member.id}`}
          onClick={state === "waiting_approval" && desk.approvalChannelId ? handleApprovalClick : undefined}
        />
      </div>
    </button>
  )
}

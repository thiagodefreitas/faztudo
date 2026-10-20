import * as Dialog from "@radix-ui/react-dialog"
import { useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { motion } from "motion/react"
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { api } from "../../api/client"
import { cx } from "../../lib/cx"
import { displayPct } from "../../lib/lane-format"
import { primaryWindow } from "../../lib/lanes"
import type { ThemeChoice } from "../../lib/theme"
import { formatAge, formatElapsed } from "../../lib/time"
import { useOpenDirect } from "../../state/direct"
import { qk } from "../../state/keys"
import { replaceById } from "../../state/merge"
import type { Approval, Channel, Department, Lane, Member, RunState } from "../../types"
import { AgentAvatar } from "../agent-avatar"
import { HealthBadge } from "../lanes"
import { WorkspaceNav } from "../sidebar"
import { avatarState, deriveLaneMeterBars, deriveTaskBoardNotes } from "./avatar"
import { DeskStateBadge, RoomDesk } from "./desk"
import { layoutRoom, roomAreas } from "./layout"
import { AreaLabelTargets, RoomBackdrop } from "./room"
import { type DeskInfo, useOfficeDesks, useReducedMotion } from "./state"
import { handleRoomKey, useRoomGestures, useRoomView } from "./use-room-view"
import { layoutSignature, viewGeometry, ZOOM_STEP } from "./zoom"
import { ZoomControls } from "./zoom-controls"

const RUN_STATE_LABEL: Record<RunState, string> = {
  queued: "Queued",
  running: "Running",
  waiting_approval: "Waiting for approval",
  verifying: "Verifying",
  done: "Verified",
  failed: "Failed",
  cancelled: "Cancelled",
}

const RUN_STATE_CLASS: Record<RunState, string> = {
  queued: "bg-sidebar text-muted",
  running: "bg-accent-soft text-accent",
  waiting_approval: "bg-warn-soft text-warn",
  verifying: "bg-accent-soft text-accent",
  done: "bg-ok-soft text-ok",
  failed: "bg-danger-soft text-danger",
  cancelled: "bg-sidebar text-muted",
}

const ACTIVE_RUN_STATES = new Set<RunState>(["queued", "running", "waiting_approval", "verifying"])

const LEGEND = [
  { key: "working", label: "Working", dot: "bg-accent" },
  { key: "waiting", label: "Waiting", dot: "bg-warn" },
  { key: "failed", label: "Failed", dot: "bg-danger" },
  { key: "quota", label: "Out of quota", dot: "bg-faint opacity-50" },
]

export function useCompactRoom(): boolean {
  return useSyncExternalStore(
    (listener) => {
      if (typeof matchMedia !== "function") return () => undefined
      const media = matchMedia("(max-width: 639px)")
      media.addEventListener?.("change", listener)
      return () => media.removeEventListener?.("change", listener)
    },
    () => typeof matchMedia === "function" && matchMedia("(max-width: 639px)").matches,
    () => false,
  )
}

export function Legend() {
  return (
    <ul
      aria-label="Legend"
      className="pointer-events-none absolute bottom-2 left-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line bg-surface/90 px-2 py-1 text-[10px] text-muted"
    >
      {LEGEND.map((item) => (
        <li key={item.key} className="flex items-center gap-1">
          <span className={cx("inline-block h-2 w-2 rounded-full", item.dot)} aria-hidden="true" />
          {item.label}
        </li>
      ))}
    </ul>
  )
}

export interface OfficeSceneProps {
  desks: DeskInfo[]
  channels: Channel[]
  lanes?: readonly Lane[] | undefined
  departments?: readonly Department[]
  messages?: readonly { author_id: string; created_at: string }[] | undefined
  compact?: boolean
  now: number
  theme?: ThemeChoice
  reducedMotion?: boolean
  initialSelectedId?: string
  onOpenApproval?: (desk: DeskInfo) => void
  onResolveApproval?: (approval: Approval, option: string, commitMessage?: string) => void | Promise<unknown>
  onMessage?: (member: Member) => void
}

export function OfficeScene({
  desks,
  channels,
  lanes: lanesProp,
  departments,
  messages,
  compact: compactProp,
  now,
  theme = "light",
  reducedMotion = false,
  initialSelectedId,
  onOpenApproval,
  onResolveApproval,
  onMessage,
}: OfficeSceneProps) {
  const compactMedia = useCompactRoom()
  const compact = compactProp ?? compactMedia
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId ?? null)
  const selectedDesk = desks.find((desk) => desk.member.id === selectedId) ?? null

  const lastMessageAtByAuthor = useMemo(() => {
    const map = new Map<string, number>()
    if (!messages) return map
    for (const msg of messages) {
      const parsed = Date.parse(msg.created_at)
      if (Number.isNaN(parsed)) continue
      const prev = map.get(msg.author_id) ?? -Infinity
      if (parsed > prev) map.set(msg.author_id, parsed)
    }
    return map
  }, [messages])

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

  // The room is laid out for the box it is drawn in, rounded to a tenth so a
  // window drag does not re-lay it out at every pixel.
  const roomRef = useRef<HTMLDivElement>(null)
  const [measured, setMeasured] = useState<number | null>(null)
  const layoutAspect = measured === null ? undefined : Math.max(0.2, Math.round(measured * 10) / 10)
  const room = useMemo(
    () => layoutRoom(desks, { departments, compact, aspect: layoutAspect }),
    [desks, departments, compact, layoutAspect],
  )
  const areas = useMemo(() => roomAreas(room), [room])
  const empty = desks.length === 0

  // The window onto the room. Its aspect follows the box the room is drawn in.
  const aspect = measured ?? room.width / room.height
  useEffect(() => {
    const el = roomRef.current
    if (!el || typeof ResizeObserver === "undefined") return
    const measure = () => {
      if (el.clientWidth > 0 && el.clientHeight > 0) setMeasured(el.clientWidth / el.clientHeight)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [empty])
  const geometry = useMemo(
    () => viewGeometry(room.width, room.height, aspect, compact),
    [room.width, room.height, aspect, compact],
  )
  const sig = useMemo(
    () => layoutSignature(room.width, room.height, room.seats.map((seat) => seat.desk.member.id)),
    [room.width, room.height, room.seats],
  )
  const view = useRoomView({ geometry, sig, reducedMotion })
  useRoomGestures(roomRef, view, compact, !empty)

  // Escape goes back to fit-all, unless a desk panel or a dialog is open and uses it first.
  const { zoomed, fit } = view
  useEffect(() => {
    if (!zoomed || selectedDesk) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return
      const target = event.target
      if (target instanceof HTMLElement && target.closest("input, textarea, select")) return
      if (document.querySelector('[role="dialog"]')) return
      fit()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [zoomed, fit, selectedDesk])

  const taskNotes = useMemo(() => deriveTaskBoardNotes(desks), [desks])
  const laneBars = useMemo(() => deriveLaneMeterBars(lanes, theme), [lanes, theme])

  const counts = {
    working: desks.filter((desk) => {
      if (desk.state === "working") return true
      if (desk.isDirector) {
        const lastAt = lastMessageAtByAuthor.get(desk.member.id)
        return lastAt !== undefined && now - lastAt >= 0 && now - lastAt <= 60_000
      }
      return false
    }).length,
    waiting: desks.filter((desk) => desk.state === "waiting_approval").length,
    queued: desks.filter((desk) => desk.state === "queued").length,
    failed: desks.filter((desk) => desk.state === "failed").length,
    outOfQuota: desks.filter((desk) => desk.outOfQuota || desk.state === "out_of_quota").length,
  }

  function handleSelect(desk: DeskInfo) {
    setSelectedId((prev) => (prev === desk.member.id ? prev : desk.member.id))
  }

  function handleApproval(desk: DeskInfo) {
    setSelectedId(desk.member.id)
    onOpenApproval?.(desk)
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 overflow-x-hidden">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 p-2 sm:p-4">
        <div className="flex flex-wrap items-center justify-between gap-2 text-[12px]">
          <div className="flex items-center gap-2">
            <span className="inline-block h-2 w-2 rounded-full bg-accent" aria-hidden="true" />
            <span className="font-medium text-ink">Studio floor</span>
            <span className="font-mono text-faint">{desks.length} desks</span>
          </div>
          <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] tabular-nums">
            <span className="rounded bg-accent-soft px-1.5 py-0.5 text-accent">
              {counts.working} working
            </span>
            {counts.waiting > 0 && (
              <span className="rounded bg-warn-soft px-1.5 py-0.5 text-warn">
                {counts.waiting} waiting approval
              </span>
            )}
            {counts.queued > 0 && (
              <span className="rounded bg-sidebar px-1.5 py-0.5 text-muted">
                {counts.queued} queued
              </span>
            )}
            {counts.failed > 0 && (
              <span className="rounded bg-danger-soft px-1.5 py-0.5 text-danger">
                {counts.failed} failed
              </span>
            )}
            {counts.outOfQuota > 0 && (
              <span className="rounded bg-danger-soft px-1.5 py-0.5 text-danger">
                {counts.outOfQuota} out of quota
              </span>
            )}
          </div>
        </div>

        {desks.length === 0 ? (
          <p className="py-12 text-center text-[13px] text-muted">No workspace members yet.</p>
        ) : (
          <div className="relative min-h-0 flex-1 overflow-hidden rounded-2xl border border-line bg-canvas shadow-xs">
            {/* The back wall sits flush at the top (`xMidYMin meet`). On phones, pods reflow vertically inside this box.
                Zooming moves the viewBox instead of scaling a picture, so text stays sharp. At fit-all the box is
                drawn exactly as before. */}
            <div
              ref={roomRef}
              data-testid="office-room"
              data-compact={compact ? "true" : "false"}
              data-zoom={view.state.zoom.toFixed(2)}
              role="region"
              aria-label="Office floor. Plus and minus zoom, 0 fits all, arrows pan."
              tabIndex={0}
              onKeyDown={(event) => {
                const target = event.target
                if (target instanceof HTMLElement && target.closest("input, textarea, select")) return
                if (handleRoomKey(view, event)) event.preventDefault()
              }}
              style={{ touchAction: compact && !view.active ? "pan-y" : "none" }}
              className={cx(
                "h-full overflow-x-hidden focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent",
                view.active ? "overflow-y-hidden" : "overflow-y-auto",
              )}
            >
              <svg
                viewBox={
                  view.active
                    ? `${view.rect.x} ${view.rect.y} ${view.rect.w} ${view.rect.h}`
                    : `0 0 ${room.width} ${room.height}`
                }
                preserveAspectRatio="xMidYMin meet"
                role="group"
                aria-label="Office floor plan"
                className={cx("mx-auto block w-full select-none", compact && !view.active ? "h-auto" : "h-full")}
              >
                <RoomBackdrop
                  width={room.width}
                  height={room.height}
                  zones={room.zones}
                  rug={room.rug}
                  taskNotes={taskNotes}
                  laneBars={laneBars}
                  onAreaClick={view.focusRect}
                />
                {room.seats.map((seat) => (
                  <RoomDesk
                    key={seat.desk.member.id}
                    desk={seat.desk}
                    x={seat.x}
                    y={seat.y}
                    scale={seat.scale}
                    {...(seat.facing ? { facing: seat.facing } : {})}
                    lastMessageAt={lastMessageAtByAuthor.get(seat.desk.member.id)}
                    now={now}
                    selected={selectedDesk?.member.id === seat.desk.member.id}
                    reducedMotion={reducedMotion}
                    onSelect={handleSelect}
                    onOpenApproval={handleApproval}
                  />
                ))}
                <AreaLabelTargets zones={room.zones} rug={room.rug} onSelect={view.focusRect} />
              </svg>
            </div>
            <ZoomControls
              areas={areas}
              onFit={view.fit}
              onJump={view.focusRect}
              onZoomIn={() => view.zoomBy(ZOOM_STEP)}
              onZoomOut={() => view.zoomBy(1 / ZOOM_STEP)}
              canZoomIn={view.canZoomIn}
              canZoomOut={view.canZoomOut}
            />
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
          onOpenApproval={onOpenApproval}
          onResolveApproval={onResolveApproval}
          onMessage={onMessage}
        />
      )}
    </div>
  )
}

export function DeskDetailPanel({
  desk,
  channels,
  now,
  reducedMotion,
  onClose,
  onOpenApproval,
  onResolveApproval,
  onMessage,
}: {
  desk: DeskInfo
  channels: Channel[]
  now: number
  reducedMotion: boolean
  onClose: () => void
  onOpenApproval?: ((desk: DeskInfo) => void) | undefined
  onResolveApproval?: ((approval: Approval, option: string, commitMessage?: string) => void | Promise<unknown>) | undefined
  onMessage?: ((member: Member) => void) | undefined
}) {
  const { member, lane, laneId, outOfQuota, currentRun, runTitle, pendingApproval, approvalChannelId } = desk
  const [resolving, setResolving] = useState(false)
  const window = lane ? primaryWindow(lane) : undefined
  const pct = window && lane ? displayPct(window, lane.health) : undefined
  const runChannel = currentRun ? channels.find((item) => item.id === currentRun.channel_id) : undefined
  const approvalChannel = approvalChannelId ? channels.find((item) => item.id === approvalChannelId) : undefined
  const runLive = currentRun ? ACTIVE_RUN_STATES.has(currentRun.state) : false
  const runElapsed = currentRun
    ? formatElapsed(currentRun.started_at, runLive ? undefined : currentRun.ended_at, now)
    : undefined

  const approvalOptions =
    pendingApproval && pendingApproval.options.length > 0
      ? pendingApproval.options
      : [
          { key: "merge", label: "Merge", style: "primary" as const },
          { key: "keep", label: "Keep" },
          { key: "discard", label: "Discard", style: "danger" as const },
        ]

  async function handleMiniResolve(option: string) {
    if (!pendingApproval || !onResolveApproval) return
    setResolving(true)
    try {
      const commitMessage = option === "merge" ? pendingApproval.commit_message : undefined
      await onResolveApproval(pendingApproval, option, commitMessage)
    } finally {
      setResolving(false)
    }
  }

  const content = (
    <>
      <header className="flex items-center gap-2.5 border-b border-line px-3 py-2.5">
        <AgentAvatar member={member} size={36} state={avatarState(desk.state)} decorative />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h2 className="truncate text-[14px] font-semibold text-ink">{member.display_name}</h2>
            <span className="rounded bg-sidebar px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase text-muted">
              {desk.isDirector ? "Director" : "Agent"}
            </span>
          </div>
          <p className="truncate font-mono text-[12px] text-muted">@{member.handle}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="min-h-8 rounded border border-line px-2 text-[12px] text-ink hover:bg-canvas"
        >
          Close
        </button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3">
        {/* Status & Message CTA */}
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-canvas p-2.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <DeskStateBadge state={desk.state} />
            {outOfQuota && desk.state !== "out_of_quota" && (
              <span className="rounded-full bg-danger-soft px-2 py-0.5 font-mono text-[11px] font-medium text-danger">
                out of quota
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={() => onMessage?.(member)}
            className="min-h-8 rounded-md bg-accent px-3 text-[12px] font-medium text-canvas hover:opacity-95"
          >
            Message
          </button>
        </div>

        {/* Mini approval card */}
        {(pendingApproval || (desk.state === "waiting_approval" && approvalChannelId)) && (
          <section
            aria-label="Pending approval"
            data-testid="mini-approval-card"
            className="rounded-lg border border-warn/50 bg-warn-soft/50 p-3"
          >
            <p className="text-[11px] font-semibold uppercase tracking-wide text-warn">
              Waiting for approval
            </p>
            {pendingApproval && (
              <>
                <p className="mt-1 text-[13px] font-medium text-ink">{pendingApproval.title}</p>
                {pendingApproval.detail && (
                  <p className="mt-0.5 text-[12px] text-muted">{pendingApproval.detail}</p>
                )}
                {pendingApproval.state === "pending" && (
                  <div className="mt-2.5 flex flex-wrap gap-1.5">
                    {approvalOptions.map((option) => (
                      <button
                        key={option.key}
                        type="button"
                        disabled={resolving}
                        onClick={() => void handleMiniResolve(option.key)}
                        className={cx(
                          "min-h-8 rounded-md border px-2.5 text-[12px] font-medium disabled:opacity-50",
                          option.style === "primary" && "border-accent bg-accent text-canvas hover:opacity-95",
                          option.style === "danger" && "border-danger bg-surface text-danger hover:bg-danger-soft",
                          !option.style && "border-line bg-surface text-ink hover:bg-canvas",
                        )}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
            {approvalChannelId && (
              <div className="mt-2 flex items-center gap-2">
                <Link
                  to="/c/$channelId"
                  params={{ channelId: approvalChannelId }}
                  search={currentRun ? { run: currentRun.id } : {}}
                  onClick={() => onOpenApproval?.(desk)}
                  className="inline-flex min-h-8 items-center rounded-md border border-warn bg-surface px-2.5 text-[12px] font-medium text-warn hover:bg-canvas"
                >
                  Open #{approvalChannel?.name ?? approvalChannelId}
                </Link>
              </div>
            )}
          </section>
        )}

        {/* Lane and health */}
        <section aria-label="Lane and health" className="rounded-lg border border-line bg-canvas p-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-[11px] font-medium uppercase tracking-wide text-faint">Lane &amp; health</h3>
            <Link to="/lanes" className="text-[11px] font-medium text-accent hover:underline">
              All lanes
            </Link>
          </div>
          {lane ? (
            <div className="mt-2 flex flex-col gap-1.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-mono text-[13px] font-medium text-ink">{lane.id}</span>
                <HealthBadge health={lane.health} />
              </div>
              {lane.model && <p className="font-mono text-[12px] text-muted">{lane.model}</p>}
              {lane.health_reason && <p className="text-[12px] text-muted">{lane.health_reason}</p>}
              <div className="mt-1 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-1.5 font-mono text-[11px] text-muted">
                <span>
                  Running {lane.running} / {lane.capacity}
                </span>
                {window && (
                  <span>
                    {window.name}: {pct === undefined ? "unknown" : `${Math.round(pct)}%`} ({window.source},{" "}
                    {formatAge(window.measured_at, now)})
                  </span>
                )}
              </div>
            </div>
          ) : laneId ? (
            <div className="mt-2 flex items-center justify-between gap-2">
              <span className="font-mono text-[13px] text-ink">{laneId}</span>
              <HealthBadge health="unknown" />
            </div>
          ) : (
            <p className="mt-1.5 text-[12px] text-muted">
              {desk.isDirector ? "Human workspace member (no CLI lane)." : "No lane configured."}
            </p>
          )}
        </section>

        {/* Current or last run */}
        <section aria-label="Current or last run" className="rounded-lg border border-line bg-canvas p-3">
          <h3 className="text-[11px] font-medium uppercase tracking-wide text-faint">
            {runLive ? "Current run" : "Last run"}
          </h3>
          {currentRun ? (
            <div className="mt-2 flex flex-col gap-2">
              {runTitle && <p className="text-[13px] font-medium text-ink">{runTitle}</p>}
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={cx(
                    "rounded px-1.5 py-0.5 text-[11px] font-medium",
                    RUN_STATE_CLASS[currentRun.state],
                  )}
                >
                  {RUN_STATE_LABEL[currentRun.state]}
                </span>
                <span className="font-mono text-[12px] text-muted">{currentRun.lane_id}</span>
                <span className="text-[12px] text-faint">{currentRun.mode}</span>
                {runElapsed && (
                  <span className="ml-auto font-mono text-[12px] tabular-nums text-muted">
                    {runElapsed}
                  </span>
                )}
              </div>
              {currentRun.failure_reason && (
                <p className="text-[12px] text-danger">{currentRun.failure_reason}</p>
              )}
              <div className="flex items-center justify-between gap-2 border-t border-line pt-2 text-[12px]">
                <span className="truncate text-muted">
                  Channel:{" "}
                  <span className="font-medium text-ink">
                    #{runChannel?.name ?? currentRun.channel_id}
                  </span>
                </span>
                <Link
                  to="/c/$channelId"
                  params={{ channelId: currentRun.channel_id }}
                  search={{ run: currentRun.id }}
                  className="shrink-0 font-medium text-accent hover:underline"
                >
                  Open in #{runChannel?.name ?? currentRun.channel_id}
                </Link>
              </div>
            </div>
          ) : (
            <p className="mt-1.5 text-[12px] text-muted">No runs recorded yet.</p>
          )}
        </section>
      </div>
    </>
  )

  const panelClass =
    "fixed inset-0 z-30 flex min-h-0 flex-col bg-surface md:static md:z-auto md:w-80 md:shrink-0 md:border-l md:border-line lg:w-96"

  if (reducedMotion) {
    return (
      <aside aria-label={`${member.display_name} details`} className={panelClass}>
        {content}
      </aside>
    )
  }

  return (
    <motion.aside
      aria-label={`${member.display_name} details`}
      className={panelClass}
      initial={{ opacity: 0, x: 12 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.16 }}
    >
      {content}
    </motion.aside>
  )
}

export function OfficeViewToggle({ mode }: { mode: "2d" | "3d" }) {
  return (
    <nav aria-label="Office view mode" className="ml-auto inline-flex items-center rounded-lg border border-line bg-sidebar p-0.5 text-[12px]">
      <Link
        to="/office"
        aria-current={mode === "2d" ? "page" : undefined}
        className={cx(
          "rounded-md px-2.5 py-1 font-medium transition-colors",
          mode === "2d" ? "bg-surface text-ink shadow-xs" : "text-muted hover:text-ink",
        )}
      >
        2D
      </Link>
      <Link
        to="/office/3d"
        aria-current={mode === "3d" ? "page" : undefined}
        className={cx(
          "rounded-md px-2.5 py-1 font-medium transition-colors",
          mode === "3d" ? "bg-surface text-ink shadow-xs" : "text-muted hover:text-ink",
        )}
      >
        3D
      </Link>
    </nav>
  )
}

export function OfficePage() {
  const { desks, channels, lanes, departments, isPending, now, theme } = useOfficeDesks()
  const reducedMotion = useReducedMotion()
  const openDirect = useOpenDirect()
  const qc = useQueryClient()
  const [navOpen, setNavOpen] = useState(false)

  // Read on every render (the clock ticks it) so the Director's typing pose follows new messages.
  const cachedMessages: { author_id: string; created_at: string }[] = []
  for (const ch of channels) {
    const msgs = qc.getQueryData<{ author_id: string; created_at: string }[]>(qk.messages(ch.id))
    if (Array.isArray(msgs)) cachedMessages.push(...msgs)
  }

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
        <OfficeViewToggle mode="2d" />
      </header>
      {isPending ? (
        <p className="p-4 text-[13px] text-muted">Loading office</p>
      ) : (
        <OfficeScene
          desks={desks}
          channels={channels}
          lanes={lanes}
          departments={departments}
          messages={cachedMessages}
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

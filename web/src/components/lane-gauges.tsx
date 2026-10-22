import * as Tooltip from "@radix-ui/react-tooltip"
import { Link, useRouterState } from "@tanstack/react-router"
import { cx } from "../lib/cx"
import { laneGauge, lanesChip } from "../lib/lane-gauge"
import { displayPct } from "../lib/lane-format"
import { HEALTH_META } from "../lib/lane-health"
import { primaryWindow } from "../lib/lanes"
import { useNow } from "../state/now"
import { useLanes } from "../state/queries"
import type { Lane, LaneHealth } from "../types"
import { healthBarClass, healthDotClass } from "./lane-chip"

// How many lanes the strip shows before the rest fold into "+N".
export const MAX_VISIBLE_LANES = 6

// A lane that is out, near out, or unmeasured. These come first and stand out.
const ATTENTION: ReadonlySet<LaneHealth> = new Set<LaneHealth>(["exhausted", "unavailable", "conserve", "unknown"])

const ATTENTION_CLASS: Record<LaneHealth, string> = {
  exhausted: "border-danger/30 bg-danger-soft text-danger",
  unavailable: "border-danger/30 bg-danger-soft text-danger",
  conserve: "border-warn/30 bg-warn-soft text-warn",
  unknown: "border-dashed border-faint/60 bg-canvas text-muted",
  available: "",
}

const TOOLTIP = "z-50 max-w-72 rounded-md border border-line bg-surface px-2.5 py-1.5 text-[12px] leading-5 text-ink shadow-md"

/** Lanes that need attention first (worst first), then the healthy ones by name. */
export function orderLanes(lanes: Lane[]): Lane[] {
  return lanes.slice().sort((a, b) => {
    const aa = ATTENTION.has(a.health)
    const bb = ATTENTION.has(b.health)
    if (aa !== bb) return aa ? -1 : 1
    if (aa && HEALTH_META[a.health].rank !== HEALTH_META[b.health].rank) return HEALTH_META[b.health].rank - HEALTH_META[a.health].rank
    return a.id.localeCompare(b.id)
  })
}

// A tiny usage bar. Without a percent there is no bar: the text says so.
function UsageBar({ pct, health }: { pct: number | undefined; health: LaneHealth }) {
  if (pct === undefined) return null
  const width = Math.max(0, Math.min(100, pct))
  return (
    <span className="h-1 w-8 shrink-0 overflow-hidden rounded-full bg-line" aria-hidden>
      <span className={cx("block h-full rounded-full", healthBarClass(health))} style={{ width: `${width}%` }} />
    </span>
  )
}

// Desktop: one calm gauge per lane in a slim strip. Phone: a single "Lanes" chip.
// Both open the Lanes page; a gauge opens it at its own lane.
export function LaneGauges() {
  const lanes = useLanes()
  const now = useNow()
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const list = orderLanes(lanes.data ?? [])
  if (list.length === 0) return null
  const chip = lanesChip(list)
  const shown = list.slice(0, MAX_VISIBLE_LANES)
  const folded = list.slice(MAX_VISIBLE_LANES)
  return (
    <div className={cx(
        "flex shrink-0 items-center border-b border-line bg-surface px-3 py-1 text-[12px]",
        pathname === "/lanes" && "max-md:hidden",
      )}>
      {pathname !== "/lanes" && (
        <Link
          to="/lanes"
          aria-label={`${chip.label}, worst health ${chip.health}`}
          className="inline-flex min-h-7 items-center gap-1.5 rounded-full border border-line bg-canvas px-2 tabular-nums text-muted md:hidden"
        >
          <span className={cx("h-1.5 w-1.5 shrink-0 rounded-full", healthDotClass(chip.health))} aria-hidden />
          {chip.label}
        </Link>
      )}
      <ul aria-label="Lane gauges" className="hidden min-w-0 items-center gap-1 overflow-x-auto md:flex">
        {shown.map((lane) => {
          const gauge = laneGauge(lane, now)
          const attention = ATTENTION.has(lane.health)
          const window = primaryWindow(lane)
          const pct = window ? displayPct(window, lane.health) : undefined
          return (
            <li key={lane.id} className="shrink-0">
              <Tooltip.Root>
                <Tooltip.Trigger asChild>
                  <Link
                    to="/lanes"
                    search={gauge.href}
                    aria-label={`${gauge.id}: ${gauge.health}, ${gauge.text}`}
                    className={cx(
                      "inline-flex min-h-6 items-center gap-1.5 rounded-md border px-2 transition-colors",
                      attention ? ATTENTION_CLASS[lane.health] : "border-transparent text-muted hover:bg-canvas hover:text-ink",
                    )}
                  >
                    <span className={cx("h-1.5 w-1.5 shrink-0 rounded-full", healthDotClass(gauge.health))} aria-hidden />
                    <span className={cx(attention ? "font-medium text-ink" : "text-muted")}>{gauge.id}</span>
                    <UsageBar pct={pct} health={lane.health} />
                    <span className="tabular-nums">{gauge.text}</span>
                    {attention && gauge.text.toLowerCase() !== HEALTH_META[lane.health].label.toLowerCase() && <span className="text-[11px] font-medium">{HEALTH_META[lane.health].label}</span>}
                  </Link>
                </Tooltip.Trigger>
                <Tooltip.Portal>
                  <Tooltip.Content sideOffset={6} className={TOOLTIP}>
                    {gauge.tooltip.map((line, i) => (
                      <p key={line} className={i === 0 ? "font-medium" : undefined}>
                        {line}
                      </p>
                    ))}
                  </Tooltip.Content>
                </Tooltip.Portal>
              </Tooltip.Root>
            </li>
          )
        })}
        {folded.length > 0 && (
          <li className="shrink-0">
            <Tooltip.Root>
              <Tooltip.Trigger asChild>
                <Link
                  to="/lanes"
                  aria-label={`${folded.length} more lanes`}
                  className="inline-flex min-h-6 items-center rounded-md px-2 tabular-nums text-muted transition-colors hover:bg-canvas hover:text-ink"
                >
                  +{folded.length}
                </Link>
              </Tooltip.Trigger>
              <Tooltip.Portal>
                <Tooltip.Content sideOffset={6} className={TOOLTIP}>
                  {folded.map((lane) => (
                    <p key={lane.id}>
                      {lane.id}: {HEALTH_META[lane.health].label}, {laneGauge(lane, now).text}
                    </p>
                  ))}
                </Tooltip.Content>
              </Tooltip.Portal>
            </Tooltip.Root>
          </li>
        )}
      </ul>
    </div>
  )
}

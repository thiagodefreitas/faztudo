import * as Tooltip from "@radix-ui/react-tooltip"
import { cx } from "../lib/cx"
import { primaryWindow } from "../lib/lanes"
import { formatAge } from "../lib/time"
import type { Lane, LaneHealth } from "../types"

const DOT: Record<LaneHealth, string> = {
  available: "bg-ok",
  conserve: "bg-warn",
  exhausted: "bg-danger",
  unavailable: "bg-faint",
  unknown: "border border-faint bg-transparent",
}

export function healthDotClass(health: LaneHealth): string {
  return DOT[health]
}

const BAR: Record<LaneHealth, string> = {
  available: "bg-ok",
  conserve: "bg-warn",
  exhausted: "bg-danger",
  unavailable: "bg-faint",
  unknown: "bg-faint",
}

// The fill of a small usage bar, by health.
export function healthBarClass(health: LaneHealth): string {
  return BAR[health]
}

export function LaneChip({ lane, now }: { lane: Lane | undefined; now: number }) {
  const health = lane?.health ?? "unknown"
  const window = lane ? primaryWindow(lane) : undefined
  const source = window?.source ?? "unknown"
  const age = formatAge(window?.measured_at, now)
  const label = `${health} · ${source} · ${age}`
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-line bg-canvas px-2 py-0.5 text-[12px] tabular-nums text-muted">
          <span className={cx("h-1.5 w-1.5 shrink-0 rounded-full", healthDotClass(health))} aria-hidden />
          <span className="truncate">{label}</span>
        </span>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          sideOffset={6}
          className="z-50 max-w-64 rounded-md border border-line bg-surface px-2.5 py-1.5 text-[12px] leading-5 text-ink shadow-md"
        >
          <p className="font-medium">{lane?.id ?? "No lane"}</p>
          {lane?.health_reason && <p>{lane.health_reason}</p>}
          {window?.used_pct !== undefined && (
            <p>
              {window.name} window {Math.round(window.used_pct)}%
            </p>
          )}
          <p>
            source {source}, {age}
          </p>
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  )
}

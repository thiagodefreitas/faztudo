import * as Tooltip from "@radix-ui/react-tooltip"
import { Link, useRouterState } from "@tanstack/react-router"
import { cx } from "../lib/cx"
import { laneGauge, lanesChip } from "../lib/lane-gauge"
import { useNow } from "../state/now"
import { useLanes } from "../state/queries"
import { healthDotClass } from "./lane-chip"

// Desktop: one gauge per lane in a slim strip. Phone: a single "Lanes" chip.
// Both open the Lanes page; a gauge opens it at its own lane.
export function LaneGauges() {
  const lanes = useLanes()
  const now = useNow()
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const list = (lanes.data ?? []).slice().sort((a, b) => a.id.localeCompare(b.id))
  if (list.length === 0) return null
  const chip = lanesChip(list)
  return (
    <div className={cx(
        "flex shrink-0 items-center border-b border-line bg-surface px-3 py-1 text-[12px]",
        pathname === "/lanes" && "max-md:hidden",
      )}>
      {pathname !== "/lanes" && (
        <Link
          to="/lanes"
          aria-label={`${chip.label}, worst health ${chip.health}`}
          className="inline-flex min-h-7 items-center gap-1.5 rounded-full border border-line bg-canvas px-2 text-muted md:hidden"
        >
          <span className={cx("h-1.5 w-1.5 shrink-0 rounded-full", healthDotClass(chip.health))} aria-hidden />
          {chip.label}
        </Link>
      )}
      <ul aria-label="Lane gauges" className="hidden min-w-0 items-center gap-1 overflow-x-auto md:flex">
        {list.map((lane) => {
          const gauge = laneGauge(lane, now)
          return (
            <li key={lane.id} className="shrink-0">
              <Tooltip.Root>
                <Tooltip.Trigger asChild>
                  <Link
                    to="/lanes"
                    search={gauge.href}
                    aria-label={`${gauge.id}: ${gauge.health}, ${gauge.text}`}
                    className="inline-flex min-h-6 items-center gap-1.5 rounded px-1.5 text-muted hover:bg-canvas hover:text-ink"
                  >
                    <span className={cx("h-1.5 w-1.5 shrink-0 rounded-full", healthDotClass(gauge.health))} aria-hidden />
                    <span className="font-mono">{gauge.id}</span>
                    <span className="font-mono tabular-nums text-ink">{gauge.text}</span>
                  </Link>
                </Tooltip.Trigger>
                <Tooltip.Portal>
                  <Tooltip.Content
                    sideOffset={6}
                    className="z-50 max-w-72 rounded-md border border-line bg-surface px-2.5 py-1.5 text-[12px] leading-5 text-ink shadow-lg"
                  >
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
      </ul>
    </div>
  )
}

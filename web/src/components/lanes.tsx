import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate, useSearch } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { api } from "../api/client"
import { cx } from "../lib/cx"
import { compactTokens, displayPct, formatCountdown, formatTokens, sparklinePath } from "../lib/lane-format"
import { HEALTH_META, summarizeLanes } from "../lib/lane-health"
import { laneRunUsage, runsTodayOf } from "../lib/lanes"
import { formatAge } from "../lib/time"
import { qk } from "../state/keys"
import { replaceById } from "../state/merge"
import { useNow } from "../state/now"
import { useLanes, useRuns } from "../state/queries"
import type { Lane, LaneHealth, LaneUsageReading, LaneWindow, Run } from "../types"

function WindowHistory({ window, history, now }: { window: LaneWindow; history: LaneUsageReading[]; now: number }) {
  const readings = history.filter((r) => r.window.name === window.name)
  return <div className="mt-1 flex gap-2">
    {([1, 7] as const).map((days) => {
      const path = sparklinePath(readings, now - days * 86_400_000, now)
      return <div key={days} className="min-w-0 flex-1">
        <span className="font-mono text-[10px] text-faint">{days === 1 ? "24h" : "7d"}</span>
        <svg role="img" aria-label={`${window.name} usage, last ${days === 1 ? "24 hours" : "7 days"}`} viewBox="0 0 100 24" preserveAspectRatio="none" className="h-6 w-full text-accent">
          {path ? <path d={path} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" /> : <path d="M0 23H100" fill="none" stroke="currentColor" strokeDasharray="2 3" opacity="0.35" />}
        </svg>
      </div>
    })}
  </div>
}

// Alt+L jumps to the Lanes page from anywhere, except while typing.
export function useLanesShortcut(): void {
  const navigate = useNavigate()
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      if (event.key.toLowerCase() !== "l") return
      const target = event.target
      if (target instanceof HTMLElement) {
        const tag = target.tagName
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) return
      }
      event.preventDefault()
      void navigate({ to: "/lanes" })
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [navigate])
}

export function HealthIcon({ health, className }: { health: LaneHealth; className?: string }) {
  switch (health) {
    case "available":
      return (
        <svg viewBox="0 0 10 10" className={className} aria-hidden="true">
          <circle cx="5" cy="5" r="4" fill="currentColor" />
        </svg>
      )
    case "conserve":
      return (
        <svg viewBox="0 0 10 10" className={className} aria-hidden="true">
          <path d="M5 1.2 9 8.8H1Z" fill="currentColor" />
        </svg>
      )
    case "exhausted":
      return (
        <svg viewBox="0 0 10 10" className={className} aria-hidden="true">
          <rect x="1" y="1" width="8" height="8" fill="currentColor" />
          <path d="M2.6 2.6 7.4 7.4M7.4 2.6 2.6 7.4" stroke="var(--color-surface)" strokeWidth="1.2" />
        </svg>
      )
    case "unavailable":
      return (
        <svg viewBox="0 0 10 10" className={className} fill="none" aria-hidden="true">
          <circle cx="5" cy="5" r="3.6" stroke="currentColor" strokeWidth="1.4" />
          <path d="M2.2 7.8 7.8 2.2" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      )
    case "unknown":
      return (
        <svg viewBox="0 0 10 10" className={className} fill="none" aria-hidden="true">
          <circle cx="5" cy="5" r="3.6" stroke="currentColor" strokeWidth="1.2" strokeDasharray="1.6 1.4" />
          <path d="M3.6 3.4a1.6 1.6 0 1 1 2.5 1.3c-.5.4-.6.7-.6 1.2" stroke="currentColor" strokeWidth="1.1" />
          <circle cx="5.1" cy="7.6" r="0.6" fill="currentColor" />
        </svg>
      )
  }
}

export function HealthBadge({ health }: { health: LaneHealth }) {
  const meta = HEALTH_META[health]
  return (
    <span
      data-health={health}
      className={cx("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium", meta.badgeClass)}
    >
      <HealthIcon health={health} className="h-2.5 w-2.5 shrink-0" />
      {meta.label}
    </span>
  )
}

// Fill pattern per docs/design.md: solid, hatch, full bar with end stop,
// muted cross-hatch, or an empty dashed outline when nothing is known.
function WindowFill({ health, pct }: { health: LaneHealth; pct: number | undefined }) {
  if (pct === undefined) {
    return <div data-pattern="dashed" className="h-2 rounded-sm border border-dashed border-faint" aria-hidden="true" />
  }
  switch (health) {
    case "available":
      return <div data-pattern="solid" className="h-2 rounded-sm bg-ok" style={{ width: `${pct}%` }} aria-hidden="true" />
    case "conserve":
      return (
        <div
          data-pattern="hatch"
          className="h-2 rounded-sm text-warn"
          style={{
            width: `${pct}%`,
            backgroundImage: "repeating-linear-gradient(45deg, currentColor 0 2px, transparent 2px 6px)",
          }}
          aria-hidden="true"
        />
      )
    case "exhausted":
      return (
        <div data-pattern="full" className="relative h-2 w-full rounded-sm bg-danger" aria-hidden="true">
          <span className="absolute inset-y-0 right-0 w-0.5 bg-ink/70" />
        </div>
      )
    case "unavailable":
      return (
        <div
          data-pattern="cross"
          className="h-2 rounded-sm text-faint"
          style={{
            width: `${pct}%`,
            backgroundImage:
              "repeating-linear-gradient(45deg, currentColor 0 1.5px, transparent 1.5px 5px), repeating-linear-gradient(-45deg, currentColor 0 1.5px, transparent 1.5px 5px)",
          }}
          aria-hidden="true"
        />
      )
    case "unknown":
      return <div data-pattern="dashed" className="h-2 rounded-sm border border-dashed border-faint" aria-hidden="true" />
  }
}

function WindowBar({ lane, window, now, history }: { lane: Lane; window: LaneWindow; now: number; history: LaneUsageReading[] }) {
  const pct = displayPct(window, lane.health)
  // Without a percentage, a CLI that logs tokens still says how much it used.
  const tokens = pct === undefined && window.tokens !== undefined ? `${compactTokens(window.tokens)} tokens` : undefined
  const label =
    pct !== undefined
      ? `${window.name} window ${Math.round(pct)} percent`
      : tokens !== undefined
        ? `${window.name} window ${tokens} used, no limit set`
        : `${window.name} window unknown`
  return (
    <li data-window={window.name}>
      <div className="flex items-baseline justify-between gap-2">
        <p className="font-mono text-[12px] text-muted">{window.name}</p>
        <p className="font-mono text-[12px] tabular-nums text-ink">{pct !== undefined ? `${Math.round(pct)}%` : (tokens ?? "unknown")}</p>
      </div>
      <div className="mt-1" role="img" aria-label={label}>
        <WindowFill health={lane.health} pct={pct} />
      </div>
      <div className="mt-0.5 flex items-baseline justify-between gap-2 font-mono text-[11px] text-faint">
        <span>
          {window.source}, {formatAge(window.measured_at, now)}
        </span>
        <span>{formatCountdown(window.resets_at, now)}</span>
      </div>
      <WindowHistory window={window} history={history} now={now} />
    </li>
  )
}

export function LaneCardView({
  lane,
  now,
  probing,
  probeError,
  onProbe,
  history = [],
  runs = [],
}: {
  lane: Lane
  now: number
  probing: boolean
  probeError: string | undefined
  onProbe: () => void
  history?: LaneUsageReading[]
  runs?: Run[]
}) {
  const usage = laneRunUsage(runs, lane.id, now)
  return (
    <article aria-label={`lane ${lane.id}`} data-health={lane.health} className="flex flex-col rounded-md border border-line bg-surface p-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <p className="font-mono text-[13px] font-medium">{lane.id}</p>
        <p className="text-[12px] text-faint">{lane.cli}</p>
        <p className="font-mono text-[12px] text-muted">{lane.model ?? "model unknown"}</p>
        <p className="text-[12px] text-faint">{lane.cost_class}</p>
        <span className="ml-auto">
          <HealthBadge health={lane.health} />
        </span>
      </div>
      {lane.health_reason && <p className="mt-1 text-[12px] text-muted">{lane.health_reason}</p>}
      {lane.windows.length > 0 && (
        <ul className="mt-2 flex flex-col gap-2">
          {lane.windows.map((window) => (
            <WindowBar key={window.name} lane={lane} window={window} now={now} history={history} />
          ))}
        </ul>
      )}
      <dl className="mt-3 grid grid-cols-3 gap-2 border-t border-line pt-2">
        <div>
          <dt className="text-[11px] uppercase tracking-wide text-faint">Running</dt>
          <dd className="font-mono text-[12px] tabular-nums text-ink">
            {lane.running} / {lane.capacity}
          </dd>
        </div>
        <div>
          <dt className="text-[11px] uppercase tracking-wide text-faint">Runs today</dt>
          <dd className="font-mono text-[12px] tabular-nums text-ink">{runsTodayOf(lane, now) ?? "-"}</dd>
        </div>
        <div>
          <dt className="text-[11px] uppercase tracking-wide text-faint">Tokens last hour</dt>
          <dd className="font-mono text-[12px] tabular-nums text-ink">{formatTokens(lane.tokens_last_hour)}</dd>
        </div>
      </dl>
      <p className="mt-2 text-[12px] text-muted">
        Today: {usage.measured ? `${formatTokens(usage.tokens)} tokens` : "tokens unknown"} ({usage.measured} of {usage.runs} runs measured)
        {usage.priced > 0
          ? `; about $${usage.cost.toFixed(usage.cost < 0.01 ? 4 : 2)}, estimate (${usage.priced} of ${usage.runs} priced)`
          : "; cost unknown"}
      </p>
      {lane.last_error && (
        <div className="mt-2 rounded-md border-l-2 border-danger bg-danger-soft px-2 py-1.5">
          <p className="text-[12px] font-medium text-danger">{lane.last_error.class}</p>
          <p className="text-[12px] text-ink">{lane.last_error.message}</p>
          <p className="font-mono text-[11px] text-muted">{formatAge(lane.last_error.at, now)}</p>
        </div>
      )}
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={onProbe}
          disabled={probing}
          className="min-h-8 rounded-md border border-line px-2 text-[12px] disabled:opacity-60"
        >
          {probing ? "Probing..." : "Probe now"}
        </button>
        {probeError && (
          <p role="alert" className="text-[12px] text-danger">
            {probeError}
          </p>
        )}
      </div>
    </article>
  )
}

function LaneCard({ lane, now, focused, runs }: { lane: Lane; now: number; focused: boolean; runs: Run[] }) {
  const qc = useQueryClient()
  const [probing, setProbing] = useState(false)
  const [probeError, setProbeError] = useState<string | undefined>(undefined)
  const history = useQuery({
    queryKey: ["lane-history", lane.id],
    queryFn: async (): Promise<LaneUsageReading[]> => {
      const response = await fetch(`/api/v1/lanes/${encodeURIComponent(lane.id)}/history`, { credentials: "same-origin" })
      if (!response.ok) throw new Error("Lane history unavailable")
      return response.json() as Promise<LaneUsageReading[]>
    },
    staleTime: 60_000,
  })

  function probe() {
    setProbing(true)
    setProbeError(undefined)
    void api.probeLane(lane.id).then(
      (next) => {
        setProbing(false)
        qc.setQueryData<Lane[]>(qk.lanes, (list = []) => replaceById(list, next))
      },
      (error: unknown) => {
        setProbing(false)
        setProbeError(error instanceof Error ? error.message : "Probe failed")
      },
    )
  }

  return (
    <div
      ref={(el) => {
        if (focused && el && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center" })
      }}
      data-focused={focused || undefined}
      className={cx("rounded-md", focused && "ring-2 ring-accent")}
    >
      <LaneCardView lane={lane} now={now} probing={probing} probeError={probeError} onProbe={probe} history={history.data} runs={runs} />
    </div>
  )
}

export function LanesPage() {
  const lanes = useLanes()
  const runs = useRuns()
  const focus = useSearch({ strict: false }).lane
  const now = useNow()
  useLanesShortcut()
  const list = (lanes.data ?? []).slice().sort((a, b) => a.id.localeCompare(b.id))

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex items-baseline gap-3 border-b border-line px-3 py-2">
        <h1 className="text-[15px] font-semibold">Lanes</h1>
        <p className="font-mono text-[12px] text-muted">{list.length} lanes, Alt+L</p>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {lanes.isPending ? (
          <p className="text-[13px] text-muted">Loading lanes</p>
        ) : list.length === 0 ? (
          <p className="text-[13px] text-muted">No lanes configured.</p>
        ) : (
          <div className="grid items-start gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {list.map((lane) => (
              <LaneCard key={lane.id} lane={lane} now={now} focused={lane.id === focus} runs={runs.data ?? []} />
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

// Compact footer gauge: worst lane health as shape plus text, and the lane
// count. Links to the Lanes page.
export function LanesGauge({ lanes }: { lanes: Lane[] }) {
  useLanesShortcut()
  const summary = summarizeLanes(lanes)
  const meta = HEALTH_META[summary.health]
  return (
    <Link
      to="/lanes"
      title="Lanes (Alt+L)"
      aria-label={`Lane health: ${meta.label}, ${summary.total} lanes`}
      className="flex min-h-10 items-center gap-2 rounded px-2 text-[13px] hover:bg-canvas md:min-h-7"
    >
      <HealthIcon health={summary.health} className={cx("h-2.5 w-2.5 shrink-0", meta.gaugeClass)} />
      <span>Lanes</span>
      <span className="sr-only">{meta.label}</span>
      <span className="ml-auto font-mono text-[12px] tabular-nums text-faint">{summary.total}</span>
    </Link>
  )
}

import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate, useSearch } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { api } from "../api/client"
import { cx } from "../lib/cx"
import { compactTokens, displayPct, formatCostAbout, formatCountdown, sortLanes, sourceLabel, sparklinePath } from "../lib/lane-format"
import { HEALTH_META, summarizeLanes } from "../lib/lane-health"
import { laneRunUsage, primaryWindow, runsTodayOf } from "../lib/lanes"
import { laneAdvice } from "../lib/lane-advice"
import { formatAge } from "../lib/time"
import { qk } from "../state/keys"
import { replaceById } from "../state/merge"
import { useNow } from "../state/now"
import { useLanes, useMembers, useRuns } from "../state/queries"
import type { Lane, LaneHealth, LaneUsageReading, LaneWindow, Run } from "../types"
import { CARD, EmptyState, Kbd, PageHeader } from "./page-header"

function WindowHistory({ window, history, now }: { window: LaneWindow; history: LaneUsageReading[]; now: number }) {
  const readings = history.filter((r) => r.window.name === window.name)
  return <div className="mt-1 flex gap-2">
    {([1, 7] as const).map((days) => {
      const path = sparklinePath(readings, now - days * 86_400_000, now)
      return <div key={days} className="min-w-0 flex-1">
        <span className="text-[10px] text-faint">{days === 1 ? "24h" : "7d"}</span>
        <svg role="img" aria-label={`${window.name} usage, last ${days === 1 ? "24 hours" : "7 days"}`} viewBox="0 0 100 24" preserveAspectRatio="none" className="h-6 w-full text-accent">
          {path ? <path d={path} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" /> : <path d="M0 23H100" fill="none" stroke="currentColor" strokeDasharray="2 3" opacity="0.35" />}
        </svg>
      </div>
    })}
  </div>
}

// True when some window has at least two readings in the last week.
function hasHistory(lane: Lane, history: LaneUsageReading[], now: number): boolean {
  return lane.windows.some((window) => sparklinePath(history.filter((r) => r.window.name === window.name), now - 7 * 86_400_000, now) !== "")
}

const VIEW_KEY = "faztudo.lanes.view"
export type LanesView = "cards" | "list"

export function readLanesView(): LanesView {
  try {
    return localStorage.getItem(VIEW_KEY) === "list" ? "list" : "cards"
  } catch {
    return "cards"
  }
}

function writeLanesView(view: LanesView): void {
  try {
    localStorage.setItem(VIEW_KEY, view)
  } catch {
    // Private mode: the choice lasts until the page closes.
  }
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

function WindowBar({ lane, window, now, history, showHistory }: { lane: Lane; window: LaneWindow; now: number; history: LaneUsageReading[]; showHistory: boolean }) {
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
      <div className="flex items-baseline gap-2 text-[12px]">
        <p className="w-9 shrink-0 text-muted">{window.name}</p>
        <p className="shrink-0 font-medium tabular-nums text-ink">{pct !== undefined ? `${Math.round(pct)}%` : (tokens ?? "unknown")}</p>
        <p className="min-w-0 flex-1 truncate text-right text-faint">{formatCountdown(window.resets_at, now)}</p>
        <span
          data-testid="window-source"
          title={`${window.source}, ${formatAge(window.measured_at, now)}`}
          className="shrink-0 rounded bg-sidebar px-1.5 text-[10px] text-faint"
        >
          {sourceLabel(window.source)}
        </span>
      </div>
      <div className="mt-1" role="img" aria-label={label}>
        <WindowFill health={lane.health} pct={pct} />
      </div>
      {showHistory && <WindowHistory window={window} history={history} now={now} />}
    </li>
  )
}

function LaneIdentity({ lane }: { lane: Lane }) {
  return (
    <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12px] text-muted">
      <span>{lane.cli}</span>
      {lane.model && <span>{lane.model}</span>}
      <span data-testid="cost-class" className="rounded bg-sidebar px-1.5 text-[10px] text-faint">
        {lane.cost_class}
      </span>
    </p>
  )
}

function ErrorBlock({ lane, now, advice }: { lane: Lane; now: number; advice?: string | undefined }) {
  return (
    <>
      {lane.last_error && (
        <div className="mt-2 rounded-md border-l-2 border-danger bg-danger-soft px-2 py-1.5">
          <p className="text-[12px] font-medium text-danger">{lane.last_error.class}</p>
          <p className="text-[12px] text-ink">{lane.last_error.message}</p>
          <p className="text-[11px] tabular-nums text-muted">{formatAge(lane.last_error.at, now)}</p>
        </div>
      )}
      {advice && (
        <p data-testid="lane-advice" className="mt-2 text-[12px] font-medium text-ink">
          {advice}
        </p>
      )}
    </>
  )
}

const PROBE_BUTTON =
  "min-h-10 rounded-lg border border-line bg-surface px-3 text-[12px] font-medium transition-colors duration-150 hover:bg-sidebar disabled:opacity-60 md:min-h-8"

export function LaneCardView({
  lane,
  now,
  probing,
  probeError,
  onProbe,
  history = [],
  runs = [],
  advice,
}: {
  lane: Lane
  now: number
  probing: boolean
  probeError: string | undefined
  onProbe: () => void
  history?: LaneUsageReading[]
  runs?: Run[]
  /** One next-step line shown with the error or exhausted state. */
  advice?: string | undefined
}) {
  const usage = laneRunUsage(runs, lane.id, now)
  const cost = usage.priced > 0 ? formatCostAbout(usage.cost) : undefined
  const showHistory = hasHistory(lane, history, now)
  const stats: [string, string][] = [
    ["Running", `${lane.running} / ${lane.capacity}`],
    ["Runs today", String(runsTodayOf(lane, now) ?? "-")],
    ["Tokens last hour", lane.tokens_last_hour === undefined ? "-" : compactTokens(lane.tokens_last_hour)],
  ]
  return (
    <article aria-label={`lane ${lane.id}`} data-health={lane.health} className={cx(CARD, "flex flex-col p-4")}>
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 truncate text-[14px] font-semibold">{lane.id}</p>
        <span className="shrink-0">
          <HealthBadge health={lane.health} />
        </span>
      </div>
      <div className="mt-0.5">
        <LaneIdentity lane={lane} />
      </div>
      {lane.health_reason && <p className="mt-1 text-[12px] text-muted">{lane.health_reason}</p>}
      {lane.windows.length > 0 && (
        <ul className="mt-3 flex flex-col gap-2.5">
          {lane.windows.map((window) => (
            <WindowBar key={window.name} lane={lane} window={window} now={now} history={history} showHistory={showHistory} />
          ))}
        </ul>
      )}
      {lane.windows.length > 0 && !showHistory && (
        <p data-testid="no-history" className="mt-2 text-[11px] text-faint">
          No history yet
        </p>
      )}
      <dl className="mt-3 grid grid-cols-3 gap-2 border-t border-line pt-2">
        {stats.map(([term, value]) => (
          <div key={term}>
            <dt className="text-[11px] text-faint">{term}</dt>
            <dd className="text-[13px] font-medium tabular-nums text-ink">{value}</dd>
          </div>
        ))}
      </dl>
      {cost && (
        <p className="mt-2 text-[12px] text-muted" title={`${usage.priced} of ${usage.runs} runs priced, estimate`}>
          {cost} today
        </p>
      )}
      <ErrorBlock lane={lane} now={now} advice={advice} />
      <div className="mt-3 flex items-center gap-2">
        <button type="button" onClick={onProbe} disabled={probing} className={PROBE_BUTTON}>
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

// One row per lane, for people with many lanes.
export function LaneRowView({
  lane,
  now,
  probing,
  probeError,
  onProbe,
  advice,
}: {
  lane: Lane
  now: number
  probing: boolean
  probeError: string | undefined
  onProbe: () => void
  advice?: string | undefined
}) {
  const window = primaryWindow(lane)
  const pct = window ? displayPct(window, lane.health) : undefined
  return (
    <article aria-label={`lane ${lane.id}`} data-health={lane.health} data-view="row" className={cx(CARD, "px-3 py-2")}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <p className="min-w-0 flex-1 basis-40 truncate text-[13px] font-semibold">{lane.id}</p>
        <HealthBadge health={lane.health} />
        <p className="w-24 shrink-0 text-[12px] tabular-nums text-muted">
          {window ? `${window.name} ${pct !== undefined ? `${Math.round(pct)}%` : "unknown"}` : "no window"}
        </p>
        <p className="hidden w-28 shrink-0 truncate text-[12px] text-faint sm:block">{window ? formatCountdown(window.resets_at, now) : ""}</p>
        <p className="w-12 shrink-0 text-[12px] tabular-nums text-muted" title="Running / capacity">
          {lane.running} / {lane.capacity}
        </p>
        <button type="button" onClick={onProbe} disabled={probing} className={PROBE_BUTTON}>
          {probing ? "Probing..." : "Probe now"}
        </button>
      </div>
      <div className="mt-0.5">
        <LaneIdentity lane={lane} />
      </div>
      {probeError && (
        <p role="alert" className="text-[12px] text-danger">
          {probeError}
        </p>
      )}
      <ErrorBlock lane={lane} now={now} advice={advice} />
    </article>
  )
}

function LaneCard({ lane, now, focused, runs, advice, view }: { lane: Lane; now: number; focused: boolean; runs: Run[]; advice?: string | undefined; view: LanesView }) {
  const qc = useQueryClient()
  const [probing, setProbing] = useState(false)
  const [probeError, setProbeError] = useState<string | undefined>(undefined)
  const history = useQuery({
    queryKey: ["lane-history", lane.id],
    // Through the api client, so a 401 reaches the login redirect like every other call.
    queryFn: (): Promise<LaneUsageReading[]> => api.laneHistory(lane.id),
    staleTime: 60_000,
    enabled: view === "cards",
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
      className={cx("rounded-xl", focused && "ring-2 ring-accent")}
    >
      {view === "list" ? (
        <LaneRowView lane={lane} now={now} probing={probing} probeError={probeError} onProbe={probe} advice={advice} />
      ) : (
        <LaneCardView lane={lane} now={now} probing={probing} probeError={probeError} onProbe={probe} history={history.data} runs={runs} advice={advice} />
      )}
    </div>
  )
}

export function LanesPage() {
  const lanes = useLanes()
  const runs = useRuns()
  const members = useMembers()
  const focus = useSearch({ strict: false }).lane
  const now = useNow()
  useLanesShortcut()
  const list = sortLanes(lanes.data ?? [])
  const [view, setView] = useState<LanesView>(readLanesView)
  function chooseView(next: LanesView) {
    setView(next)
    writeLanesView(next)
  }

  const counts = new Map<LaneHealth, number>()
  for (const lane of list) counts.set(lane.health, (counts.get(lane.health) ?? 0) + 1)
  const order: LaneHealth[] = ["available", "conserve", "exhausted", "unavailable", "unknown"]

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHeader
        title="Lanes"
        description={
          <>
            <span className="tabular-nums">{list.length}</span> {list.length === 1 ? "lane" : "lanes"}: the CLIs and models the team runs on, and how much each has left. <Kbd>Alt</Kbd> <Kbd>L</Kbd> opens this page.
          </>
        }
        actions={
          list.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
            <div role="radiogroup" aria-label="Lane layout" className="inline-flex rounded-lg border border-line p-0.5">
              {(["cards", "list"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={view === option}
                  onClick={() => chooseView(option)}
                  className={cx("min-h-9 rounded-md px-3 text-[12px] font-medium capitalize transition-colors duration-150 md:min-h-7", view === option ? "bg-accent-soft text-ink" : "text-muted hover:text-ink")}
                >
                  {option}
                </button>
              ))}
            </div>
            <ul aria-label="Lane health" className="flex flex-wrap items-center gap-1.5">
              {order
                .filter((health) => counts.get(health))
                .map((health) => (
                  <li key={health} className={cx("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[12px] font-medium", HEALTH_META[health].badgeClass)}>
                    <HealthIcon health={health} className="h-2.5 w-2.5 shrink-0" />
                    <span className="tabular-nums">{counts.get(health)}</span> {HEALTH_META[health].label.toLowerCase()}
                  </li>
                ))}
            </ul>
            </div>
          ) : undefined
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {lanes.isPending ? (
          <p className="text-[13px] text-muted">Loading lanes</p>
        ) : list.length === 0 ? (
          <EmptyState>
            No lanes configured. Run <code className="font-mono">faztudo agents detect</code> in a terminal to find the installed CLIs, or add a <code className="font-mono">[[lane]]</code> entry to <code className="font-mono">~/.config/faztudo/lanes.toml</code> and restart the daemon.
          </EmptyState>
        ) : (
          <div className={view === "list" ? "flex flex-col gap-2" : "grid items-start gap-3 sm:grid-cols-2 xl:grid-cols-3"}>
            {list.map((lane) => (
              <LaneCard key={lane.id} lane={lane} now={now} focused={lane.id === focus} runs={runs.data ?? []} advice={laneAdvice(lane, list, members.data ?? [], now)} view={view} />
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

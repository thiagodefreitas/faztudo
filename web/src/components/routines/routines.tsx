import { useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { api } from "../../api/client"
import { cx } from "../../lib/cx"
import { qk } from "../../state/keys"
import { useNow } from "../../state/now"
import { useMembers, useRoutines } from "../../state/queries"
import type { Routine, RoutineStatus } from "../../types"
import { formatAge } from "../../lib/time"
import { AgentAvatar } from "../agent-avatar"
import { describeSchedule } from "./schedule"

const STATUS_CLASS: Record<RoutineStatus, string> = {
  ok: "bg-ok-soft text-ok",
  failed: "bg-danger-soft text-danger",
  skipped: "bg-warn-soft text-warn",
}

const STATUS_LABEL: Record<RoutineStatus, string> = {
  ok: "Done",
  failed: "Failed",
  skipped: "Skipped",
}

function whenText(routine: Routine): string {
  if (routine.schedule) return describeSchedule(routine.schedule)
  if (routine.trigger === "message") return `When someone posts in #${routine.channel}`
  return "No schedule or trigger"
}

function whatText(routine: Routine): string {
  if (routine.template === "debrief") {
    return "Debrief: what ran, what merged, what failed, approvals waiting and lane health in the last day."
  }
  return routine.prompt
}

function nextText(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ""
  return date.toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })
}

export function RoutinesList() {
  const routines = useRoutines()
  const members = useMembers()
  const qc = useQueryClient()
  const now = useNow()
  const [message, setMessage] = useState<{ level: "info" | "error"; text: string } | null>(null)

  async function act(work: () => Promise<unknown>, done?: string) {
    setMessage(null)
    try {
      await work()
      if (done) setMessage({ level: "info", text: done })
    } catch (e) {
      setMessage({ level: "error", text: e instanceof Error ? e.message : "Could not change the routine." })
    }
    await qc.invalidateQueries({ queryKey: qk.routines })
  }

  if (routines.isPending) return <p className="text-[13px] text-muted">Loading routines</p>
  const list = routines.data ?? []
  if (list.length === 0) {
    return (
      <p className="text-[13px] text-muted">
        No routines yet. Use Repeat this on a finished answer, add <code className="font-mono">[[routine]]</code> entries to lanes.toml, or start from{" "}
        <code className="font-mono">faztudo init --template solo</code>.
      </p>
    )
  }

  return (
    <div className="space-y-3">
      {message && (
        <p role={message.level === "error" ? "alert" : "status"} className={cx("text-[13px]", message.level === "error" ? "text-danger" : "text-muted")}>
          {message.text}
        </p>
      )}
      <div className="grid items-start gap-3 lg:grid-cols-2">
        {list.map((routine) => {
          const persona = (members.data ?? []).find((m) => m.kind === "agent" && m.handle.toLowerCase() === routine.persona.toLowerCase())
          const verb = routine.enabled ? "Switch off" : "Switch on"
          return (
            <article
              key={routine.handle}
              aria-label={routine.name}
              data-routine={routine.handle}
              className={cx("rounded-lg border border-line bg-surface p-3", !routine.enabled && "opacity-80")}
            >
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <h3 className="flex items-baseline gap-2 text-[14px] font-semibold">
                    {routine.name}
                    <span className="font-mono text-[11px] font-normal text-faint">{routine.handle}</span>
                    <span className="rounded-full bg-canvas px-2 py-0.5 text-[11px] font-normal text-muted">
                      {routine.source === "app" ? "Made in the app" : "From lanes.toml"}
                    </span>
                  </h3>
                  <p className="text-[13px] text-ink">{whenText(routine)}</p>
                  <p className="mt-1 flex items-center gap-2 text-[12px] text-muted">
                    {persona && <AgentAvatar member={persona} size={20} decorative />}
                    <span className="truncate">
                      @{routine.persona} in #{routine.channel}
                    </span>
                  </p>
                </div>
                <input
                  type="checkbox"
                  role="switch"
                  checked={routine.enabled}
                  aria-label={`${verb} ${routine.name}`}
                  onChange={(event) => void act(() => api.setRoutineEnabled(routine.handle, event.target.checked))}
                  className="mt-1 h-5 w-9 shrink-0 cursor-pointer accent-accent"
                />
              </div>
              <p className="mt-2 line-clamp-3 text-[12px] text-muted">{whatText(routine)}</p>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px]" data-testid={`last-${routine.handle}`}>
                {routine.last ? (
                  <>
                    <span className={cx("rounded-full px-2 py-0.5", STATUS_CLASS[routine.last.status])}>{STATUS_LABEL[routine.last.status]}</span>
                    <span className="text-muted">{formatAge(routine.last.at, now)}</span>
                    {routine.last.detail && <span className="min-w-0 flex-1 truncate text-muted">{routine.last.detail}</span>}
                  </>
                ) : (
                  <span className="text-muted">Has not run yet.</span>
                )}
              </div>
              <div className="mt-2 flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => void act(() => api.runRoutine(routine.handle), `Started ${routine.name}.`)}
                  className="min-h-10 rounded border border-line px-3 text-[13px] hover:bg-canvas md:min-h-8"
                >
                  Run now
                </button>
                {routine.source === "app" && (
                  <button
                    type="button"
                    aria-label={`Delete ${routine.name}`}
                    onClick={() => void act(() => api.deleteRoutine(routine.handle), `Deleted ${routine.name}.`)}
                    className="min-h-10 rounded border border-line px-3 text-[13px] text-danger hover:bg-canvas md:min-h-8"
                  >
                    Delete
                  </button>
                )}
                {routine.enabled && routine.next_run && <span className="text-[12px] text-muted">Next: {nextText(routine.next_run)}</span>}
                {!routine.enabled && <span className="text-[12px] text-faint">Switched off</span>}
              </div>
            </article>
          )
        })}
      </div>
    </div>
  )
}

export function RoutinesPage() {
  const routines = useRoutines()
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex items-baseline gap-3 border-b border-line px-3 py-2">
        <Link to="/organization" className="min-h-10 py-2 text-[13px] text-muted">
          Organization
        </Link>
        <h1 className="text-[15px] font-semibold">Routines</h1>
        <p className="font-mono text-[12px] text-muted">{routines.data?.length ?? 0} routines</p>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <RoutinesList />
      </div>
    </section>
  )
}

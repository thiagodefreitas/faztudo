import { useQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { motion } from "motion/react"
import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react"
import { api } from "../api/client"
import { cx } from "../lib/cx"
import { qk } from "../state/keys"
import { useMe, useMembers, useOutput, useRuns } from "../state/queries"
import { DiffView } from "./diff-view"
import { RunContext } from "./run-context"
import { RunTimeline } from "./run-timeline"

function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (listener) => {
      if (typeof matchMedia !== "function") return () => undefined
      const media = matchMedia("(prefers-reduced-motion: reduce)")
      media.addEventListener?.("change", listener)
      return () => media.removeEventListener?.("change", listener)
    },
    () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => false,
  )
}

export function RunPanel({
  channelId,
  runId,
  view,
}: {
  channelId: string
  runId: string
  view?: "diff" | "timeline" | "context"
}) {
  const navigate = useNavigate()
  const reduced = useReducedMotion()
  const runs = useRuns()
  const output = useOutput(runId)
  const diff = useQuery({
    queryKey: qk.diff(runId),
    queryFn: () => api.diff(runId),
    enabled: view === "diff",
    retry: false,
  })
  const prompt = useQuery({
    queryKey: qk.prompt(runId),
    queryFn: () => api.prompt(runId),
    enabled: view === "context",
    retry: false,
  })
  const run = runs.data?.find((item) => item.id === runId)
  const me = useMe()
  const members = useMembers()
  // Lessons are the Director's; an agent viewer sees the plain text.
  const persona = me.data?.kind === "human" ? members.data?.find((item) => item.id === run?.agent_id)?.handle : undefined
  const boxRef = useRef<HTMLPreElement>(null)
  const lines = output.data ?? []
  const tail = lines.map((line) => line.seq).join(",")

  useEffect(() => {
    const el = boxRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [tail, view])

  function close() {
    void navigate({
      to: "/c/$channelId",
      params: { channelId },
      search: {},
    })
  }

  function show(next: "output" | "diff" | "timeline" | "context") {
    void navigate({
      to: "/c/$channelId",
      params: { channelId },
      search: next === "output" ? { run: runId } : { run: runId, view: next },
    })
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return
      const target = event.target
      if (target instanceof HTMLElement && target.closest("input, textarea, select")) return
      void navigate({
        to: "/c/$channelId",
        params: { channelId },
        search: {},
      })
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [channelId, navigate])

  const body = (
    <>
      <header className="flex items-center gap-2 border-b border-line px-3 py-2">
        <h2 className="min-w-0 flex-1 truncate text-[13px] font-medium">{run ? `Run ${run.state}` : "Run"}</h2>
        <button type="button" onClick={close} className="min-h-8 rounded px-2 text-[12px]">
          Close
        </button>
      </header>
      <div className="flex gap-1 border-b border-line px-2 py-1">
        <Tab pressed={view === undefined} onClick={() => show("output")}>
          Output
        </Tab>
        <Tab pressed={view === "context"} onClick={() => show("context")}>
          Context
        </Tab>
        <Tab pressed={view === "diff"} onClick={() => show("diff")}>
          Diff
        </Tab>
        <Tab pressed={view === "timeline"} onClick={() => show("timeline")}>
          Timeline
        </Tab>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {view === "timeline" ? (
          run ? (
            <RunTimeline run={run} channelId={channelId} onShowDiff={() => show("diff")} onShowLog={() => show("output")} onShowContext={() => show("context")} />
          ) : (
            <p className="p-3 text-[13px] text-muted">The run is not loaded yet.</p>
          )
        ) : view === "context" ? (
          prompt.data ? <RunContext data={prompt.data} {...(persona ? { persona } : {})} /> : <p className="p-3 text-[13px] text-muted">{prompt.isError ? "Context is not available for this run." : "Loading context"}</p>
        ) : view === "diff" ? (
          <div className="p-2">
            {diff.isPending && <p className="text-[13px] text-muted">Loading diff</p>}
            {diff.isError && <div className="flex items-center gap-2 text-[13px] text-muted"><span>The diff is not ready.</span><button type="button" onClick={() => void diff.refetch()} className="min-h-8 rounded border border-line px-2 text-accent">Retry</button></div>}
            {diff.data && <DiffView diff={diff.data.diff} />}
          </div>
        ) : (
          <pre ref={boxRef} className="h-full overflow-auto px-3 py-2 font-mono text-[12px] leading-5">
            {lines.length === 0 ? (
              <span className="text-faint">No output yet.</span>
            ) : (
              lines.map((line) => (
                <span key={line.seq} className={line.stream === "stderr" ? "text-danger" : undefined}>
                  {line.text}
                </span>
              ))
            )}
          </pre>
        )}
      </div>
    </>
  )

  const className =
    "fixed inset-0 z-30 flex min-h-0 flex-col bg-surface xl:static xl:z-auto xl:w-[22rem] xl:shrink-0 xl:border-l xl:border-line"

  if (reduced) return <aside className={className}>{body}</aside>
  return (
    <motion.aside
      className={className}
      initial={{ opacity: 0, x: 12 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.16 }}
    >
      {body}
    </motion.aside>
  )
}

function Tab({ pressed, onClick, children }: { pressed: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cx("min-h-8 rounded px-2 text-[12px]", pressed ? "bg-accent-soft text-ink" : "text-muted")}
    >
      {children}
    </button>
  )
}

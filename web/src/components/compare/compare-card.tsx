import { useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import { api } from "../../api/client"
import type { CompareCandidate, CompareGroup } from "../../types"

function Candidate({ candidate, label, channelId }: { candidate: CompareCandidate; label: string; channelId: string }) {
  const run = candidate.run
  const navigate = useNavigate()
  const stat = run?.diff_stat
  const tail = (candidate.output_tail ?? []).join("\n").slice(-1200)
  return <section className="min-w-0 rounded-lg border border-line bg-canvas p-3" aria-label={`Candidate ${label}`}>
    <h4 className="text-[13px] font-semibold">{label}: {candidate.lane_id}</h4>
    <p className="text-[12px] text-muted">{run ? `${RUN_STATE_LABEL[run.state] ?? run.state} | ${stat?.files ?? 0} files | +${stat?.insertions ?? 0}/-${stat?.deletions ?? 0}` : "Starting"}</p>
    <p className="text-[12px]">Verification: {run?.verification ? (run.verification.ok ? "passed" : "failed") : "not reported"}{run?.verification?.detail ? `, ${run.verification.detail}` : ""}</p>
    {tail && <pre className="mt-2 max-h-24 overflow-auto whitespace-pre-wrap break-all text-[11px] text-muted">{tail}</pre>}
    {run?.worktree && <button type="button" className="mt-2 min-h-8 text-[12px] text-accent hover:underline" onClick={() => void navigate({ to: "/c/$channelId", params: { channelId }, search: { run: run.id, view: "diff" } })}>View {label} diff</button>}
  </section>
}

const RUN_STATE_LABEL: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  verifying: "Checking",
  waiting_approval: "Ready for review",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
}

export function CompareCard({ group }: { group: CompareGroup }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const qc = useQueryClient()
  const [a, b] = group.candidates
  const finished = (candidate: CompareCandidate) => candidate.run?.state === "waiting_approval" || candidate.run?.state === "done" || candidate.run?.state === "failed" || candidate.run?.state === "cancelled"
  const ready = finished(a) && finished(b)
  const hasDiff = (candidate: CompareCandidate) => (candidate.run?.diff_stat?.files ?? 0) > 0
  const mergeable = (candidate: CompareCandidate) => candidate.run?.state === "waiting_approval" && hasDiff(candidate)
  const action = "min-h-10 rounded-md border border-line px-3 text-[12px] hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-50 md:min-h-8"
  async function decide(decision: "merge_a" | "merge_b" | "discard_both" | "combine") {
    setBusy(true)
    setError("")
    try {
      await api.decideCompare(group.channel_id, group.id, decision)
      await qc.invalidateQueries({ queryKey: ["compares", group.channel_id] })
      await qc.invalidateQueries({ queryKey: ["runs"] })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not decide this comparison.")
    } finally {
      setBusy(false)
    }
  }
  return <div className="mt-3 rounded-xl border border-line bg-surface p-3" aria-label="Compare candidates">
    <h3 className="mb-2 text-[13px] font-semibold">Compare two candidates</h3>
    <div className="grid gap-2 sm:grid-cols-2"><Candidate candidate={a} label="A" channelId={group.channel_id} /><Candidate candidate={b} label="B" channelId={group.channel_id} /></div>
    {group.decision ? <p className="mt-2 text-[12px]">Decision: {group.decision.replaceAll("_", " ")}{group.winner_lane ? ` (${group.winner_lane})` : ""}</p> : <div className="mt-2 flex flex-wrap gap-2">
      <button type="button" className={action} disabled={busy || !ready || !mergeable(a)} onClick={() => void decide("merge_a")}>Merge A</button>
      <button type="button" className={action} disabled={busy || !ready || !mergeable(b)} onClick={() => void decide("merge_b")}>Merge B</button>
      <button type="button" className={action} disabled={busy || !ready} onClick={() => void decide("discard_both")}>Discard both</button>
      <button type="button" className={action} disabled={busy || !ready || !hasDiff(a) || !hasDiff(b)} onClick={() => void decide("combine")}>Combine</button>
    </div>}
    {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
  </div>
}

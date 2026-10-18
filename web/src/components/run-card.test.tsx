import { TooltipProvider } from "@radix-ui/react-tooltip"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { api } from "../api/client"
import { FAIL_LINE } from "../mock/script"
import { qk } from "../state/keys"
import type { Approval, Lane, Member, Run } from "../types"
import { RunCard, RunCardView } from "./run-card"

const now = Date.parse("2026-10-18T12:00:00.000Z")

const reviewer: Member = {
  id: "01ARZ3NDEKTSV4RRFFQ69G5AA3",
  kind: "agent",
  handle: "reviewer",
  display_name: "Reviewer",
  presence: "idle",
  agent: { lanes: ["claude/opus"], role: "Reviews diffs and plans" },
}

const lane: Lane = {
  id: "claude/opus",
  cli: "claude",
  model: "opus",
  cost_class: "premium",
  capacity: 1,
  running: 0,
  health: "conserve",
  health_reason: "week window is above 80 percent",
  windows: [{ name: "week", used_pct: 84, source: "probe", measured_at: new Date(now - 2 * 3_600_000).toISOString() }],
  runs_today: 1,
}

const failed: Run = {
  id: "01DRZ3NDEKTSV4RRFFQ69G5DD1",
  channel_id: "01BRZ3NDEKTSV4RRFFQ69G5BB1",
  trigger_message_id: "01CRZ3NDEKTSV4RRFFQ69G5CC1",
  agent_id: reviewer.id,
  lane_id: "claude/opus",
  mode: "read",
  state: "failed",
  started_at: new Date(now - 90_000).toISOString(),
  ended_at: new Date(now - 20_000).toISOString(),
  exit_code: 1,
  failure_class: "semantic",
  failure_reason: "verification failed",
  verification: { ok: false, detail: `go test ./...\n${FAIL_LINE}` },
}

const passed: Run = {
  ...failed,
  id: "01DRZ3NDEKTSV4RRFFQ69G5DD2",
  state: "done",
  mode: "write",
  lane_id: "codex/default",
  verification: { ok: true, detail: "ok: run card shows verification" },
  diff_stat: { files: 1, insertions: 2, deletions: 1 },
  failure_reason: undefined,
}

function renderCard(run: Run) {
  return render(
    <TooltipProvider>
      <RunCardView
        run={run}
        agent={reviewer}
        lane={run.state === "done" ? { ...lane, id: "codex/default", health: "available", windows: [{ name: "5h", used_pct: 22, source: "cli-log", measured_at: new Date(now - 12 * 60_000).toISOString() }] } : lane}
        lines={[{ seq: 1, stream: "stderr", text: "FAIL\n" }]}
        approval={null}
        now={now}
        onViewDiff={() => undefined}
        onCancel={() => undefined}
        onRetry={() => undefined}
        onResolve={() => undefined}
      />
    </TooltipProvider>,
  )
}

describe("RunCardView", () => {

  it("shows a merge refusal and keeps the approval pending", async () => {
    const user = userEvent.setup()
    const approval: Approval = {
      id: "approval", channel_id: failed.channel_id, requested_by: reviewer.id,
      run_id: failed.id, title: "Review change", detail: "Merge the change", state: "pending",
      commit_message: "Add change", options: [{ key: "merge", label: "Merge", style: "primary" }, { key: "keep", label: "Keep" }],
    }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    client.setQueryData(qk.members, [reviewer])
    client.setQueryData(qk.lanes, [lane])
    client.setQueryData(qk.runs, [{ ...failed, mode: "write", state: "waiting_approval" }])
    client.setQueryData(qk.approvals, [approval])
    client.setQueryData(qk.output(failed.id), [])
    client.setQueryData(qk.diff(failed.id), { diff: "" })
    client.setQueryData(qk.notices, [])
    const root = createRootRoute({ component: () => <RunCard run={{ ...failed, mode: "write", state: "waiting_approval" }} channelId={failed.channel_id} /> })
    const router = createRouter({ routeTree: root.addChildren([]), history: createMemoryHistory({ initialEntries: ["/"] }), context: {} })
    await router.load()
    const resolve = vi.spyOn(api, "resolveApproval").mockRejectedValueOnce(new Error("Merge refused: branch main moved to feature"))
    try {
      render(<QueryClientProvider client={client}><TooltipProvider><RouterProvider router={router} /></TooltipProvider></QueryClientProvider>)
      await user.click(screen.getByRole("button", { name: /Merge/ }))
      expect(await screen.findByRole("alert")).toHaveTextContent("branch main moved to feature")
      expect(screen.getByRole("button", { name: /Keep/ })).toBeEnabled()
    } finally {
      resolve.mockRestore()
    }
  })
  it("shows a failed verification with the failing output", () => {
    renderCard(failed)
    expect(screen.getAllByText("Failed").length).toBeGreaterThan(0)
    expect(screen.getByText(new RegExp(FAIL_LINE))).toBeInTheDocument()
    expect(screen.getByText(/conserve · probe · 2h ago/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument()
  })

  it("shows a pass and the diff stat", () => {
    renderCard(passed)
    expect(screen.getByText("Passed")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /View diff/ })).toHaveTextContent("View diff (1 file, +2 -1)")
    expect(screen.getByText(/available · cli-log · 12m ago/)).toBeInTheDocument()
  })

  it("shows the run's tokens and estimated cost under Details, and unknown as unknown", () => {
    const view = renderCard({ ...passed, tokens: { input: 1200, output: 300, cache_read: 0, cache_write: 0 }, cost_usd: 0.02 })
    expect(screen.getByText(/1,500 tokens/)).toBeInTheDocument()
    expect(screen.getByText(/about \$0\.02, estimate/i)).toBeInTheDocument()
    view.unmount()
    renderCard(passed)
    expect(screen.getByText(/Tokens unknown/)).toBeInTheDocument()
  })

  it("offers Retry only for failed and cancelled runs", () => {
    for (const state of ["queued", "running", "waiting_approval", "verifying", "done"] as const) {
      const view = renderCard({ ...failed, state })
      expect(screen.queryByRole("button", { name: "Retry" }), state).not.toBeInTheDocument()
      view.unmount()
    }
    for (const state of ["failed", "cancelled"] as const) {
      const view = renderCard({ ...failed, state })
      expect(screen.getByRole("button", { name: "Retry" }), state).toBeInTheDocument()
      view.unmount()
    }
  })
})

import { TooltipProvider } from "@radix-ui/react-tooltip"
import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { FAIL_LINE } from "../mock/script"
import type { Lane, Member, Run } from "../types"
import { RunCardView } from "./run-card"

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
    expect(screen.getByRole("button", { name: /View diff/ })).toHaveTextContent("1 file")
    expect(screen.getByRole("button", { name: /View diff/ })).toHaveTextContent("+2")
    expect(screen.getByText(/available · cli-log · 12m ago/)).toBeInTheDocument()
  })
})

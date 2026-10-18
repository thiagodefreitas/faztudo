import { TooltipProvider } from "@radix-ui/react-tooltip"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import type { Approval, Member, Run } from "../types"
import { RunCardView } from "./run-card"

const now = Date.parse("2026-10-18T12:00:00.000Z")

const coder: Member = {
  id: "a1",
  kind: "agent",
  handle: "coder",
  display_name: "Coder",
  presence: "busy",
  agent: { lanes: ["codex/default", "claude/sonnet"] },
}

const waiting: Run = {
  id: "r1",
  channel_id: "c1",
  trigger_message_id: "m1",
  agent_id: "a1",
  lane_id: "claude/sonnet",
  mode: "write",
  state: "waiting_approval",
  started_at: new Date(now - 4 * 60_000).toISOString(),
  diff_stat: { files: 3, insertions: 12, deletions: 4 },
  verification: { ok: true, detail: "all tests passed" },
}

const approval: Approval = {
  id: "ap1",
  run_id: "r1",
  channel_id: "c1",
  requested_by: "a1",
  title: "Merge the login fix",
  detail: "",
  options: [{ key: "merge", label: "Merge", style: "primary" }],
  state: "pending",
}

function renderCard(run: Run, extra: { why?: string; approval?: Approval | null; onTimeline?: () => void; lines?: { seq: number; stream: "stdout" | "stderr"; text: string }[] } = {}) {
  return render(
    <TooltipProvider>
      <RunCardView
        run={run}
        agent={coder}
        lane={undefined}
        lines={extra.lines ?? []}
        approval={extra.approval ?? null}
        now={now}
        {...(extra.why ? { why: extra.why } : {})}
        {...(extra.onTimeline ? { onTimeline: extra.onTimeline } : {})}
        onViewDiff={() => undefined}
        onCancel={() => undefined}
        onRetry={() => undefined}
        onResolve={() => undefined}
      />
    </TooltipProvider>,
  )
}

describe("RunCardView sentence and details", () => {
  it("leads with one plain sentence", () => {
    renderCard(waiting, { approval })
    expect(screen.getByTestId("run-sentence")).toHaveTextContent("Coder changed 3 files. Tests passed. Waiting for you.")
  })

  it("keeps lane, mode, time and the reason for the lane on one quiet line", () => {
    renderCard(waiting, { why: "codex/default skipped: busy" })
    const line = screen.getByText("claude/sonnet").closest("p") as HTMLElement
    expect(line).toHaveTextContent("write")
    expect(line).toHaveTextContent("4m 00s")
    expect(line).toHaveTextContent("codex/default skipped: busy")
  })

  it("folds a passing verification under Details", () => {
    renderCard({ ...waiting, state: "done" })
    const details = screen.getByText("Details").closest("details") as HTMLDetailsElement
    expect(details.open).toBe(false)
    expect(details).toContainElement(screen.getByText("all tests passed"))
  })

  it("shows failing checks outside Details", () => {
    renderCard({ ...waiting, state: "failed", verification: { ok: false, detail: "FAIL TestLogin" } })
    const details = screen.getByText("Details").closest("details") as HTMLElement
    expect(details).not.toContainElement(screen.getByText("FAIL TestLogin"))
  })

  it("shows the last three output lines of a live run only", () => {
    const lines = ["one", "two", "three", "four"].map((text, i) => ({ seq: i + 1, stream: "stdout" as const, text: `${text}\n` }))
    const view = renderCard({ ...waiting, state: "running" }, { lines })
    // The folded output holds all four lines; the peek repeats the last three.
    expect(screen.getAllByText("four")).toHaveLength(2)
    expect(screen.getAllByText("two")).toHaveLength(2)
    expect(screen.getAllByText("one")).toHaveLength(1)
    view.unmount()
    renderCard({ ...waiting, state: "done" }, { lines })
    expect(screen.getAllByText("four")).toHaveLength(1)
  })

  it("offers the one action that fits: Cancel while working, Retry when failed", () => {
    const view = renderCard({ ...waiting, state: "running" })
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument()
    view.unmount()
    renderCard({ ...waiting, state: "failed" })
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument()
  })

  it("opens the timeline from Details", async () => {
    const user = userEvent.setup()
    const open = vi.fn()
    renderCard({ ...waiting, state: "done" }, { onTimeline: open })
    await user.click(screen.getByText("Details"))
    await user.click(screen.getByRole("button", { name: "Open timeline" }))
    expect(open).toHaveBeenCalledOnce()
  })
})

import { describe, expect, it } from "vitest"
import type { Approval, Lane, Member, Run } from "../../types"
import { deriveMemberDesk, deriveOfficeDesks, FAIL_WINDOW_MS, resolveMemberHue } from "./state"

const now = Date.parse("2026-10-18T12:00:00.000Z")

const director: Member = {
  id: "mem-human",
  kind: "human",
  handle: "director",
  display_name: "Ada Director",
  presence: "online",
}

const claudeAgent: Member = {
  id: "mem-claude",
  kind: "agent",
  handle: "claude",
  display_name: "Claude",
  presence: "online",
  agent: { lanes: ["claude/opus"], role: "architect", mode: "write" },
}

const codexAgent: Member = {
  id: "mem-codex",
  kind: "agent",
  handle: "codex",
  display_name: "Codex",
  presence: "busy",
  agent: { lanes: ["codex/default"], role: "coder", mode: "write" },
}

const healthyLane: Lane = {
  id: "claude/opus",
  cli: "claude",
  model: "claude-opus-4",
  cost_class: "premium",
  capacity: 2,
  running: 0,
  health: "available",
  windows: [{ name: "5h", used_pct: 30, source: "cli-log" }],
  runs_today: 4,
}

const exhaustedLane: Lane = {
  id: "codex/default",
  cli: "codex",
  model: "codex-1",
  cost_class: "standard",
  capacity: 1,
  running: 0,
  health: "exhausted",
  health_reason: "5h quota exhausted",
  windows: [{ name: "5h", used_pct: 100, source: "error" }],
  runs_today: 9,
}

function makeRun(overrides: Partial<Run>): Run {
  return {
    id: "run-1",
    channel_id: "ch-general",
    trigger_message_id: "msg-1",
    agent_id: claudeAgent.id,
    lane_id: "claude/opus",
    mode: "write",
    state: "running",
    started_at: new Date(now - 75_000).toISOString(),
    ...overrides,
  }
}

function makeApproval(overrides: Partial<Approval>): Approval {
  return {
    id: "app-1",
    run_id: "run-1",
    channel_id: "ch-general",
    requested_by: claudeAgent.id,
    title: "Merge feature branch",
    detail: "Ready to merge",
    options: [{ key: "merge", label: "Merge", style: "primary" }],
    state: "pending",
    ...overrides,
  }
}

describe("deriveMemberDesk", () => {
  it("derives idle state when member has no active runs, failures or quota issues", () => {
    const desk = deriveMemberDesk({
      member: claudeAgent,
      runs: [],
      approvals: [],
      lanes: [healthyLane],
      now,
    })
    expect(desk.state).toBe("idle")
    expect(desk.stateLabel).toBe("idle")
    expect(desk.hue).toBe("claude")
    expect(desk.initial).toBe("C")
    expect(desk.monogram).toBe("CL")
    expect(desk.outOfQuota).toBe(false)
  })

  it("derives working state with elapsed time when a run is running or verifying", () => {
    const running = makeRun({ state: "running", started_at: new Date(now - 85_000).toISOString() })
    const desk = deriveMemberDesk({
      member: claudeAgent,
      runs: [running],
      approvals: [],
      lanes: [healthyLane],
      now,
    })
    expect(desk.state).toBe("working")
    expect(desk.elapsedText).toBe("1m 25s")
    expect(desk.currentRun?.id).toBe(running.id)
  })

  it("derives queued state when a run is queued and none are working", () => {
    const queued = makeRun({ state: "queued" })
    const desk = deriveMemberDesk({
      member: claudeAgent,
      runs: [queued],
      approvals: [],
      lanes: [healthyLane],
      now,
    })
    expect(desk.state).toBe("queued")
    expect(desk.stateLabel).toBe("queued")
  })

  it("derives waiting_approval state from a pending approval or waiting_approval run", () => {
    const waitingRun = makeRun({ state: "waiting_approval", channel_id: "ch-review" })
    const approval = makeApproval({ run_id: waitingRun.id, channel_id: "ch-review" })
    const desk = deriveMemberDesk({
      member: claudeAgent,
      runs: [waitingRun],
      approvals: [approval],
      lanes: [healthyLane],
      now,
    })
    expect(desk.state).toBe("waiting_approval")
    expect(desk.approvalChannelId).toBe("ch-review")
    expect(desk.pendingApproval?.id).toBe("app-1")
  })

  it("derives failed state only when the last terminal run failed within the 10 minute window", () => {
    const recentFail = makeRun({
      id: "run-recent-fail",
      state: "failed",
      ended_at: new Date(now - 4 * 60_000).toISOString(),
    })
    const recentDesk = deriveMemberDesk({
      member: claudeAgent,
      runs: [recentFail],
      approvals: [],
      lanes: [healthyLane],
      now,
    })
    expect(recentDesk.state).toBe("failed")

    const staleFail = makeRun({
      id: "run-stale-fail",
      state: "failed",
      ended_at: new Date(now - FAIL_WINDOW_MS - 5_000).toISOString(),
    })
    const staleDesk = deriveMemberDesk({
      member: claudeAgent,
      runs: [staleFail],
      approvals: [],
      lanes: [healthyLane],
      now,
    })
    expect(staleDesk.state).toBe("idle")
  })

  it("derives out_of_quota when the member lane is exhausted or unavailable", () => {
    const desk = deriveMemberDesk({
      member: codexAgent,
      runs: [],
      approvals: [],
      lanes: [exhaustedLane],
      now,
    })
    expect(desk.state).toBe("out_of_quota")
    expect(desk.outOfQuota).toBe(true)
    expect(desk.stateLabel).toBe("out of quota")
  })

  it("places Director (human) desks ahead of agent desks and maps all six agent hues", () => {
    const desks = deriveOfficeDesks({
      members: [claudeAgent, director, codexAgent],
      runs: [],
      approvals: [],
      lanes: [healthyLane, exhaustedLane],
      now,
    })
    expect(desks.map((d) => d.member.id)).toEqual(["mem-human", "mem-claude", "mem-codex"])
    expect(desks[0]?.isDirector).toBe(true)

    for (const key of ["claude", "codex", "agy", "kimi", "opencode", "grok"] as const) {
      const m: Member = { id: `m-${key}`, kind: "agent", handle: key, display_name: key, presence: "online" }
      expect(resolveMemberHue(m)).toBe(key)
    }
  })
})

import { describe, expect, it } from "vitest"
import type { Approval, Department, Lane, Member, Run } from "../../types"
import { derive2DCharacterView, deriveLaneMeterBars, deriveTaskBoardNotes } from "./avatar"
import { layoutRoom, layoutWallFixtures } from "./layout"
import {
  deriveMemberDesk,
  deriveOfficeDesks,
  DONE_WINDOW_MS,
  FAIL_WINDOW_MS,
  formatResetTime,
  formatRunTitle,
  laneBorrower,
  resolveMemberHue,
} from "./state"

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
    expect(desk.runTitle).toBeUndefined()
  })

  it("derives working state with elapsed time and runTitle from the trigger message", () => {
    const running = makeRun({
      state: "running",
      trigger_message_id: "msg-trigger",
      started_at: new Date(now - 85_000).toISOString(),
    })
    const triggerMessages = new Map([["msg-trigger", "@claude Refactor the office layout and add tests for pods"]])
    const desk = deriveMemberDesk({
      member: claudeAgent,
      runs: [running],
      approvals: [],
      lanes: [healthyLane],
      triggerMessages,
      now,
    })
    expect(desk.state).toBe("working")
    expect(desk.elapsedText).toBe("1m 25s")
    expect(desk.currentRun?.id).toBe(running.id)
    expect(desk.runTitle).toBe("Refactor the office layout and add...")
  })

  it("strips leading mentions and lane commands in formatRunTitle", () => {
    expect(formatRunTitle("@coder /lane codex/default Fix the auth race condition in login")).toBe(
      "Fix the auth race condition in...",
    )
    expect(formatRunTitle("Short task")).toBe("Short task")
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
    expect(desk.runTitle).toBe("Merge feature branch")
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

describe("laneBorrower", () => {
  const coder: Member = {
    id: "mem-coder",
    kind: "agent",
    handle: "coder",
    display_name: "Coder",
    presence: "busy",
    agent: { lanes: ["claude/opus"], role: "coder", mode: "write" },
  }
  const members = [director, claudeAgent, coder]
  const personaRun = (overrides: Partial<Run> = {}) =>
    makeRun({ id: "run-p", agent_id: coder.id, lane_id: "claude/opus", state: "running", ...overrides })

  it("names the persona running on a raw CLI's lane", () => {
    expect(laneBorrower(claudeAgent, [personaRun()], members)?.handle).toBe("coder")
  })

  it("counts queued and verifying runs but not finished ones or other lanes", () => {
    expect(laneBorrower(claudeAgent, [personaRun({ state: "queued" })], members)).not.toBeNull()
    expect(laneBorrower(claudeAgent, [personaRun({ state: "verifying" })], members)).not.toBeNull()
    expect(laneBorrower(claudeAgent, [personaRun({ state: "done" })], members)).toBeNull()
    expect(laneBorrower(claudeAgent, [personaRun({ lane_id: "codex/default" })], members)).toBeNull()
  })

  it("ignores the CLI's own runs, personas and humans", () => {
    expect(laneBorrower(claudeAgent, [makeRun({})], members)).toBeNull()
    expect(laneBorrower(coder, [personaRun()], members)).toBeNull()
    expect(laneBorrower(director, [personaRun()], members)).toBeNull()
  })

  it("keeps the desk idle but records who borrows the lane", () => {
    const desk = deriveMemberDesk({
      member: claudeAgent,
      runs: [personaRun()],
      approvals: [],
      lanes: [healthyLane],
      now,
      members,
    })
    expect(desk.state).toBe("idle")
    expect(desk.busyFor?.handle).toBe("coder")
  })
})

describe("layoutRoom", () => {
  it("keeps every pod seat facing down across multiple rows while the Director faces up", () => {
    const members: Member[] = [
      director,
      claudeAgent,
      codexAgent,
      { id: "mem-coder", kind: "agent", handle: "coder", display_name: "Coder", presence: "online", agent: { lanes: ["codex/default"], role: "coder", mode: "write" } },
      { id: "mem-reviewer", kind: "agent", handle: "reviewer", display_name: "Reviewer", presence: "online", agent: { lanes: ["claude/opus"], role: "reviewer", mode: "read" } },
    ]
    const departments: Department[] = [
      { handle: "eng", display_name: "Engineering", lead: "claude", members: ["codex", "coder", "reviewer"] },
    ]
    const desks = deriveOfficeDesks({ members, runs: [], approvals: [], lanes: [healthyLane, exhaustedLane], now })
    const room = layoutRoom(desks, { departments })

    const agentSeats = room.seats.filter((seat) => !seat.desk.isDirector)
    expect(agentSeats).toHaveLength(4)
    // First row and second row of the 2x2 pod both sit behind their desk facing down.
    expect(agentSeats[0]?.y).toBeLessThan(agentSeats[2]!.y)
    for (const seat of agentSeats) {
      expect(seat.facing).toBe("down")
    }

    const directorSeat = room.seats.find((seat) => seat.desk.isDirector)
    expect(directorSeat?.facing).toBe("up")
  })

  it("derives doneRecently when the last run finished within DONE_WINDOW_MS and extracts resetTimeText", () => {
    const recentDone = makeRun({
      id: "run-done",
      state: "done",
      ended_at: new Date(now - 2 * 60_000).toISOString(),
    })
    const deskDone = deriveMemberDesk({
      member: claudeAgent,
      runs: [recentDone],
      approvals: [],
      lanes: [healthyLane],
      now,
    })
    expect(deskDone.state).toBe("idle")
    expect(deskDone.doneRecently).toBe(true)

    const staleDone = makeRun({
      id: "run-stale-done",
      state: "done",
      ended_at: new Date(now - DONE_WINDOW_MS - 10_000).toISOString(),
    })
    const deskStale = deriveMemberDesk({
      member: claudeAgent,
      runs: [staleDone],
      approvals: [],
      lanes: [healthyLane],
      now,
    })
    expect(deskStale.doneRecently).toBe(false)

    const laneWithReset: Lane = {
      ...exhaustedLane,
      windows: [{ name: "5h", used_pct: 100, source: "error", resets_at: "2026-10-18T14:30:00.000Z" }],
    }
    const quotaDesk = deriveMemberDesk({
      member: codexAgent,
      runs: [],
      approvals: [],
      lanes: [laneWithReset],
      now,
    })
    expect(quotaDesk.state).toBe("out_of_quota")
    expect(quotaDesk.resetTimeText).toBe("14:30")
    expect(formatResetTime("16:45")).toBe("16:45")
  })
})

describe("derive2DCharacterView and layoutWallFixtures", () => {
  it("maps every desk state to its 2D flat character pose, arms, monitor mode, and quota note", () => {
    const coder: Member = {
      id: "mem-coder",
      kind: "agent",
      handle: "coder",
      display_name: "Coder",
      presence: "online",
      agent: { lanes: ["claude/opus"], role: "coder", mode: "write" },
    }

    // Working -> typing hands on keyboard, glowing monitor
    const workingDesk = deriveMemberDesk({
      member: coder,
      runs: [makeRun({ agent_id: coder.id, state: "running" })],
      approvals: [],
      lanes: [healthyLane],
      now,
    })
    const workingView = derive2DCharacterView(workingDesk, { reducedMotion: false })
    expect(workingView.identity.headSilhouette).toBe("round_one_antenna")
    expect(workingView.identity.pinMotif).toBe("</>")
    expect(workingView.pose.pose).toBe("working")
    expect(workingView.pose.monitorMode).toBe("glow")
    expect(workingView.leftHand.y).toBeGreaterThan(workingView.leftShoulder.y)
    expect(workingView.rightHand.y).toBeGreaterThan(workingView.rightShoulder.y)

    // Waiting for approval -> raised right hand, approval card
    const waitingRun = makeRun({ id: "run-wait", agent_id: coder.id, state: "waiting_approval" })
    const waitingDesk = deriveMemberDesk({
      member: coder,
      runs: [waitingRun],
      approvals: [makeApproval({ run_id: waitingRun.id, requested_by: coder.id })],
      lanes: [healthyLane],
      now,
    })
    const waitingView = derive2DCharacterView(waitingDesk)
    expect(waitingView.pose.pose).toBe("waiting_approval")
    expect(waitingView.pose.showApprovalCard).toBe(true)
    expect(waitingView.rightHand.y).toBeLessThan(waitingView.rightShoulder.y)

    // Failed -> slumped pose, closed eyes, red desk lamp
    const failedDesk = deriveMemberDesk({
      member: coder,
      runs: [makeRun({ agent_id: coder.id, state: "failed", ended_at: new Date(now - 30_000).toISOString() })],
      approvals: [],
      lanes: [healthyLane],
      now,
    })
    const failedView = derive2DCharacterView(failedDesk)
    expect(failedView.pose.pose).toBe("failed")
    expect(failedView.pose.showRedLamp).toBe(true)
    expect(failedView.eyesClosed).toBe(true)
    expect(failedView.headCenter.y).toBeGreaterThan(15)

    // Done recently -> stretch pose with both hands raised high
    const doneDesk = deriveMemberDesk({
      member: coder,
      runs: [makeRun({ agent_id: coder.id, state: "done", ended_at: new Date(now - 30_000).toISOString() })],
      approvals: [],
      lanes: [healthyLane],
      now,
    })
    const doneView = derive2DCharacterView(doneDesk)
    expect(doneView.pose.pose).toBe("done_recently")
    expect(doneView.leftHand.y).toBeLessThan(doneView.leftShoulder.y)
    expect(doneView.rightHand.y).toBeLessThan(doneView.rightShoulder.y)

    // Out of quota -> empty chair (seated: false) + back at <time>
    const resetLane: Lane = {
      ...exhaustedLane,
      windows: [{ name: "5h", used_pct: 100, source: "error", resets_at: "2026-10-18T16:20:00.000Z" }],
    }
    const quotaDesk = deriveMemberDesk({
      member: codexAgent,
      runs: [],
      approvals: [],
      lanes: [resetLane],
      now,
    })
    const quotaView = derive2DCharacterView(quotaDesk)
    expect(quotaView.seated).toBe(false)
    expect(quotaView.pose.quotaNote).toBe("back at 16:20")

    // Busy for persona -> monitor shows persona badge motif
    const busyCliDesk = deriveMemberDesk({
      member: claudeAgent,
      runs: [makeRun({ agent_id: coder.id, lane_id: "claude/opus", state: "running" })],
      approvals: [],
      lanes: [healthyLane],
      now,
      members: [director, claudeAgent, coder],
    })
    const busyView = derive2DCharacterView(busyCliDesk)
    expect(busyView.pose.pose).toBe("busy_for_persona")
    expect(busyView.pose.monitorMode).toBe("persona_badge")
    expect(busyView.pose.personaBadgeMotif).toBe("</>")

    // Idle respects reducedMotion for looking around
    const idleDesk = deriveMemberDesk({
      member: claudeAgent,
      runs: [],
      approvals: [],
      lanes: [healthyLane],
      now,
    })
    const idleAgentView = derive2DCharacterView(idleDesk, { reducedMotion: false })
    expect(idleAgentView.figure).toBe("agent")
    expect(idleAgentView.idleGlance).toBe(true)
    expect(derive2DCharacterView(idleDesk, { reducedMotion: true }).idleGlance).toBe(false)

    // Director (human) renders a human figure with initials, hands on the desk, and types when they posted in the last minute
    const directorDesk = deriveMemberDesk({
      member: director,
      runs: [],
      approvals: [],
      lanes: [],
      now,
    })
    const idleDirectorView = derive2DCharacterView(directorDesk, { now })
    expect(idleDirectorView.figure).toBe("human")
    expect(idleDirectorView.initials).toBe("AD")
    expect(idleDirectorView.pose.pose).toBe("idle")
    // Facing up: hands rest by the torso, never raised above the shoulders
    expect(idleDirectorView.leftHand.y).toBeGreaterThan(idleDirectorView.leftShoulder.y)
    expect(idleDirectorView.rightHand.y).toBeGreaterThan(idleDirectorView.rightShoulder.y)

    const typingDirectorView = derive2DCharacterView(directorDesk, {
      lastMessageAt: new Date(now - 30_000).toISOString(),
      now,
    })
    expect(typingDirectorView.figure).toBe("human")
    expect(typingDirectorView.pose.pose).toBe("working")
    expect(typingDirectorView.pose.leftArm).toBe("typing")
    expect(typingDirectorView.pose.rightArm).toBe("typing")

    const staleDirectorView = derive2DCharacterView(directorDesk, {
      lastMessageAt: new Date(now - 90_000).toISOString(),
      now,
    })
    expect(staleDirectorView.pose.pose).toBe("idle")
  })

  it("places the task board and lane strip on the back wall when they fit and omits them when too narrow", () => {
    const running = makeRun({ state: "running", trigger_message_id: "msg-t" })
    const desks = deriveOfficeDesks({
      members: [director, claudeAgent, codexAgent],
      runs: [running],
      approvals: [],
      lanes: [healthyLane, exhaustedLane],
      triggerMessages: new Map([["msg-t", "@claude Ship 2D office characters"]]),
      now,
    })
    const notes = deriveTaskBoardNotes(desks)
    const bars = deriveLaneMeterBars([healthyLane, exhaustedLane], "light")

    const desktopWall = layoutWallFixtures(1200, notes, bars)
    expect(desktopWall.taskBoard).not.toBeNull()
    expect(desktopWall.taskBoard?.notes).toHaveLength(1)
    expect(desktopWall.laneStrip).not.toBeNull()
    expect(desktopWall.laneStrip?.bars).toHaveLength(2)

    const compactWall = layoutWallFixtures(390, notes, bars)
    expect(compactWall.taskBoard).not.toBeNull()
    expect(compactWall.laneStrip).not.toBeNull()
    expect(
      (compactWall.taskBoard?.w ?? 0) + (compactWall.laneStrip?.w ?? 0),
    ).toBeLessThanOrEqual(390)

    const tinyWall = layoutWallFixtures(180, notes, bars)
    expect(tinyWall.taskBoard).toBeNull()
    expect(tinyWall.laneStrip).toBeNull()
  })
})

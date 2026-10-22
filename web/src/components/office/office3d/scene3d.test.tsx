import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router"
import { fireEvent, render, screen, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { Approval, Channel, Department, Lane, Member, Run, StreamEvent } from "../../../types"
import { DESK_H, DESK_W, layoutRoom } from "../layout"
import { directorLabelAnchor, zoneLabelAnchor } from "./labels"
import { deriveMemberDesk, deriveOfficeDesks } from "../state"
import {
  createAnimationQueue,
  defaultCameraPose,
  deriveCharacterIdentity,
  deriveCharacterPose,
  deriveLaneMeterBars,
  deriveTaskBoardNotes,
  deriveTimeOfDayLighting,
  enqueueOfficeEvent,
  HANDOFF_DURATION_MS,
  MERGE_POP_DURATION_MS,
  OFFICE_MAX_DPR,
  Office3DScene,
  type Office3DSceneProps,
  pruneAnimationQueue,
  SCENE_PALETTES,
  sampleCharacterFrame,
  sampleHandoffWalk,
  sampleMergePop,
  toWorld,
} from "./scene3d"

// jsdom has no WebGL: keep the scene shell and its keyboard handling, drop the canvas.
vi.mock("@react-three/fiber", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@react-three/fiber")>()),
  Canvas: () => null,
}))

const now = Date.parse("2026-10-18T12:00:00.000Z")

const members: Member[] = [
  {
    id: "m-director",
    kind: "human",
    handle: "director",
    display_name: "Thiago Director",
    presence: "online",
  },
  {
    id: "m-claude",
    kind: "agent",
    handle: "claude",
    display_name: "Claude",
    presence: "online",
    agent: { lanes: ["claude/opus"], role: "architect", mode: "write" },
  },
  {
    id: "m-coder",
    kind: "agent",
    handle: "coder",
    display_name: "Coder",
    presence: "online",
    agent: { lanes: ["codex/default"], role: "coder", mode: "write" },
  },
]

const channels: Channel[] = [
  {
    id: "ch-general",
    name: "general",
    kind: "team",
    visibility: "public",
    member_ids: ["m-director", "m-claude", "m-coder"],
    unread: 0,
  },
]

const departments: Department[] = [
  {
    handle: "eng",
    display_name: "Engineering",
    lead: "claude",
    members: ["coder"],
  },
]

async function renderScene3D(overrides: Partial<Office3DSceneProps> = {}) {
  const desks = deriveOfficeDesks({ members, runs: [], approvals: [], lanes: [], now })
  const props: Office3DSceneProps = {
    desks,
    channels,
    departments,
    now,
    reducedMotion: true,
    webglAvailable: false,
    ...overrides,
  }
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <Office3DScene {...props} />
        <Outlet />
      </>
    ),
  })
  const lanesRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/lanes",
    component: () => <p>lanes view</p>,
  })
  const channelRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/c/$channelId",
    component: () => <p>channel view</p>,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([lanesRoute, channelRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  })
  await router.load()
  render(<RouterProvider router={router} />)
  return router
}

describe("Office3DScene", () => {
  it("renders the static fallback when WebGL is unavailable, shows every desk name including Coder, department labels, reset-view button, and opens the side panel", async () => {
    const onMessage = vi.fn()
    await renderScene3D({ onMessage })

    const fallback = screen.getByTestId("office3d-fallback")
    expect(fallback).toHaveTextContent("3D view is unavailable because WebGL could not be initialized on this device.")

    expect(screen.getByTestId("office3d-reset-view")).toHaveTextContent("Reset view")
    expect(screen.getByTestId("fallback-zone-dept-eng")).toHaveTextContent("Engineering")
    expect(screen.getByTestId("fallback-desk-m-coder")).toHaveTextContent("Coder")
    expect(screen.getByTestId("fallback-desk-m-coder")).toHaveAttribute("data-role-pin", "coder")
    expect(screen.getByTestId("fallback-desk-m-director")).toHaveTextContent("Thiago Director")
    expect(screen.getByTestId("fallback-desk-m-director")).toHaveAttribute("data-cli", "director")

    const claudeBtn = screen.getByTestId("fallback-desk-m-claude")
    fireEvent.click(claudeBtn)

    const panel = screen.getByRole("complementary", { name: "Claude details" })
    expect(panel).toHaveTextContent("@claude")

    fireEvent.click(screen.getByRole("button", { name: "Message" }))
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ id: "m-claude" }))
  })

  it("computes a room-framing defaultCameraPose and world coordinates for both light and dark themes", () => {
    const desks = deriveOfficeDesks({ members, runs: [], approvals: [], lanes: [], now })
    const room = layoutRoom(desks, { departments })
    const pose = defaultCameraPose(room.width, room.height)

    expect(pose.position[0]).toBe(0)
    expect(pose.position[1]).toBeGreaterThanOrEqual(8)
    expect(pose.position[2]).toBeGreaterThan(10)
    expect(pose.target).toEqual([0, 0.2, 0.3])

    const centered = toWorld({ x: room.width / 2 - 50, y: room.height / 2 - 50, w: 100, h: 100 }, room.width, room.height)
    expect(centered.x).toBeCloseTo(0)
    expect(centered.z).toBeCloseTo(0)

    expect(SCENE_PALETTES.light.surface).not.toBe(SCENE_PALETTES.light.line)
    expect(SCENE_PALETTES.dark.surface).not.toBe(SCENE_PALETTES.dark.line)
    expect(SCENE_PALETTES.dark.hemiIntensity).toBeGreaterThan(1)
  })

  it("maps each CLI to its 3D head silhouette, personas to role chest pins, and Director to a human figure", () => {
    const roster: Member[] = [
      { id: "m-dir", kind: "human", handle: "director", display_name: "Director", presence: "online" },
      { id: "m-cl", kind: "agent", handle: "claude", display_name: "Claude", presence: "online" },
      { id: "m-cx", kind: "agent", handle: "codex", display_name: "Codex", presence: "online" },
      { id: "m-ag", kind: "agent", handle: "agy", display_name: "Agy", presence: "online" },
      { id: "m-km", kind: "agent", handle: "kimi", display_name: "Kimi", presence: "online" },
      { id: "m-oc", kind: "agent", handle: "opencode", display_name: "Opencode", presence: "online" },
      { id: "m-gk", kind: "agent", handle: "grok", display_name: "Grok", presence: "online" },
      { id: "m-un", kind: "agent", handle: "mystery", display_name: "Mystery", presence: "online" },
      { id: "m-coder", kind: "agent", handle: "coder", display_name: "Coder", presence: "online", agent: { lanes: ["codex/default"] } },
      { id: "m-rev", kind: "agent", handle: "reviewer", display_name: "Reviewer", presence: "online", agent: { lanes: ["claude/opus"] } },
      { id: "m-arch", kind: "agent", handle: "architect", display_name: "Architect", presence: "online", agent: { lanes: ["claude/opus"] } },
      { id: "m-wrt", kind: "agent", handle: "writer", display_name: "Writer", presence: "online", agent: { lanes: ["agy/gemini"] } },
    ]
    const desks = deriveOfficeDesks({ members: roster, runs: [], approvals: [], lanes: [], now })
    const byId = new Map(desks.map((d) => [d.member.id, deriveCharacterIdentity(d)]))

    expect(byId.get("m-dir")).toMatchObject({ cli: "director", headSilhouette: "human", isDirector: true, rolePin: null })
    expect(byId.get("m-cl")).toMatchObject({ cli: "claude", headSilhouette: "round_one_antenna", rolePin: null })
    expect(byId.get("m-cx")).toMatchObject({ cli: "codex", headSilhouette: "square_visor", rolePin: null })
    expect(byId.get("m-ag")).toMatchObject({ cli: "agy", headSilhouette: "round_pointed_ears", rolePin: null })
    expect(byId.get("m-km")).toMatchObject({ cli: "kimi", headSilhouette: "one_big_eye", rolePin: null })
    expect(byId.get("m-oc")).toMatchObject({ cli: "opencode", headSilhouette: "square_side_bolts", rolePin: null })
    expect(byId.get("m-gk")).toMatchObject({ cli: "grok", headSilhouette: "wide_two_antennae", rolePin: null })
    expect(byId.get("m-un")).toMatchObject({ cli: "unknown", headSilhouette: "neutral", rolePin: "other", pinMotif: "dot" })
    expect(byId.get("m-coder")).toMatchObject({ cli: "codex", headSilhouette: "square_visor", rolePin: "coder", pinMotif: "</>" })
    expect(byId.get("m-rev")).toMatchObject({ cli: "claude", headSilhouette: "round_one_antenna", rolePin: "reviewer", pinMotif: "magnifier" })
    expect(byId.get("m-arch")).toMatchObject({ cli: "claude", headSilhouette: "round_one_antenna", rolePin: "architect", pinMotif: "compass" })
    expect(byId.get("m-wrt")).toMatchObject({ cli: "agy", headSilhouette: "round_pointed_ears", rolePin: "writer", pinMotif: "quill" })
  })

  it("maps every desk state to its acted-out 3D pose and respects reducedMotion", () => {
    const claude = members[1]!
    const coder = members[2]!
    const allMembers = [members[0]!, claude, coder]

    const baseLane: Lane = {
      id: "claude/opus",
      cli: "claude",
      cost_class: "premium",
      capacity: 2,
      running: 1,
      health: "available",
      windows: [{ name: "5h", used_pct: 45, source: "cli-log" }],
      runs_today: 3,
    }

    // 1. Working -> typing hands + monitor glow in agent hue
    const workingRun: Run = {
      id: "r-work",
      channel_id: "ch-general",
      trigger_message_id: "msg-1",
      agent_id: claude.id,
      lane_id: "claude/opus",
      mode: "write",
      state: "running",
      started_at: new Date(now - 30_000).toISOString(),
    }
    const workingDesk = deriveMemberDesk({ member: claude, runs: [workingRun], approvals: [], lanes: [baseLane], now })
    const workingPose = deriveCharacterPose(workingDesk, { reducedMotion: false })
    expect(workingPose).toMatchObject({
      pose: "working",
      seated: true,
      animated: true,
      leftArm: "typing",
      rightArm: "typing",
      monitorMode: "glow",
      monitorGlowHue: workingDesk.palette.accent,
    })
    const workingStatic = deriveCharacterPose(workingDesk, { reducedMotion: true })
    expect(workingStatic.animated).toBe(false)
    expect(sampleCharacterFrame(workingStatic, 2.5)).toMatchObject({ leftHandOffsetY: 0, rightHandOffsetY: 0 })
    expect(sampleCharacterFrame(workingPose, 2.5).leftHandOffsetY).not.toBe(0)

    // 2. Queued -> sitting upright + clock on monitor
    const queuedRun: Run = { ...workingRun, id: "r-q", state: "queued" }
    const queuedDesk = deriveMemberDesk({ member: claude, runs: [queuedRun], approvals: [], lanes: [baseLane], now })
    expect(deriveCharacterPose(queuedDesk)).toMatchObject({
      pose: "queued",
      seated: true,
      torsoLean: 0,
      monitorMode: "clock",
    })

    // 3. Waiting for approval -> raised hand + floating card above desk
    const waitingRun: Run = { ...workingRun, id: "r-wait", state: "waiting_approval" }
    const approval: Approval = {
      id: "ap-1",
      run_id: "r-wait",
      channel_id: "ch-general",
      requested_by: claude.id,
      title: "Merge 3D characters",
      detail: "Ready",
      options: [{ key: "merge", label: "Merge", style: "primary" }],
      state: "pending",
    }
    const waitingDesk = deriveMemberDesk({
      member: claude,
      runs: [waitingRun],
      approvals: [approval],
      lanes: [baseLane],
      now,
    })
    expect(deriveCharacterPose(waitingDesk)).toMatchObject({
      pose: "waiting_approval",
      seated: true,
      rightArm: "raised",
      showApprovalCard: true,
      monitorMode: "approval",
    })

    // 4. Failed -> red desk lamp + slumped pose
    const failedRun: Run = {
      ...workingRun,
      id: "r-fail",
      state: "failed",
      ended_at: new Date(now - 60_000).toISOString(),
    }
    const failedDesk = deriveMemberDesk({ member: claude, runs: [failedRun], approvals: [], lanes: [baseLane], now })
    const failedPose = deriveCharacterPose(failedDesk)
    expect(failedPose).toMatchObject({
      pose: "failed",
      seated: true,
      showRedLamp: true,
      leftArm: "slumped",
      rightArm: "slumped",
      monitorMode: "error",
    })
    expect(failedPose.torsoLean).toBeGreaterThan(0.3)

    // 5. Done recently -> stretch
    const doneRun: Run = {
      ...workingRun,
      id: "r-done",
      state: "done",
      ended_at: new Date(now - 90_000).toISOString(),
    }
    const doneDesk = deriveMemberDesk({ member: claude, runs: [doneRun], approvals: [], lanes: [baseLane], now })
    const donePose = deriveCharacterPose(doneDesk)
    expect(donePose).toMatchObject({
      pose: "done_recently",
      seated: true,
      leftArm: "stretch",
      rightArm: "stretch",
    })
    expect(donePose.torsoLean).toBeLessThan(0)

    // 6. Idle -> looking around, occasional doze (off under reduced motion)
    const idleDesk = deriveMemberDesk({ member: claude, runs: [], approvals: [], lanes: [baseLane], now })
    const idlePose = deriveCharacterPose(idleDesk, { reducedMotion: false })
    expect(idlePose).toMatchObject({ pose: "idle", seated: true, canDoze: true, animated: true })
    expect(sampleCharacterFrame(idlePose, 9.5, 0).dozing).toBe(true)
    const idleReduced = deriveCharacterPose(idleDesk, { reducedMotion: true })
    expect(idleReduced).toMatchObject({ pose: "idle", canDoze: false, animated: false })
    expect(sampleCharacterFrame(idleReduced, 9.5, 0).dozing).toBe(false)

    // 7. Out of quota -> empty chair with "back at <reset time>" note when known
    const exhaustedLane: Lane = {
      ...baseLane,
      health: "exhausted",
      windows: [{ name: "5h", used_pct: 100, source: "error", resets_at: "2026-10-18T15:45:00.000Z" }],
    }
    const quotaDesk = deriveMemberDesk({ member: claude, runs: [], approvals: [], lanes: [exhaustedLane], now })
    expect(deriveCharacterPose(quotaDesk)).toMatchObject({
      pose: "out_of_quota",
      seated: false,
      quotaNote: "back at 15:45",
      monitorMode: "off",
    })

    // 8. Busy for a persona -> monitor showing the persona's badge
    const borrowedCoder: Member = { ...coder, agent: { lanes: ["claude/opus"], role: "coder", mode: "write" } }
    const borrowedRun: Run = { ...workingRun, id: "r-borrow", agent_id: borrowedCoder.id, lane_id: "claude/opus" }
    const busyCliDesk = deriveMemberDesk({
      member: claude,
      runs: [borrowedRun],
      approvals: [],
      lanes: [baseLane],
      now,
      members: [members[0]!, claude, borrowedCoder],
    })
    expect(deriveCharacterPose(busyCliDesk)).toMatchObject({
      pose: "busy_for_persona",
      seated: true,
      monitorMode: "persona_badge",
      personaBadgeRole: "coder",
      personaBadgeMotif: "</>",
      personaHandle: "coder",
    })
    expect(allMembers).toHaveLength(3)
  })

  it("queues handoff walk and merge pop animations from stream events, interpolates the paper walk, and prunes expired items", () => {
    const start = now
    let queue = createAnimationQueue()

    // Handoff via delegate tool (handoff.created)
    const handoffEvent: StreamEvent = {
      seq: 1,
      id: "ev-handoff-1",
      version: 1,
      type: "handoff.created",
      actor: "claude",
      channel_id: "ch-general",
      ts: new Date(start).toISOString(),
      payload: {
        request_id: "req-1",
        from: "claude",
        to: "coder",
        depth: 1,
        message_id: "msg-h1",
      },
    }
    queue = enqueueOfficeEvent(queue, handoffEvent, { members, now: start })
    expect(queue.items).toHaveLength(1)
    const handoffAnim = queue.items[0]!
    expect(handoffAnim.kind).toBe("handoff")
    if (handoffAnim.kind === "handoff") {
      expect(handoffAnim.fromMemberId).toBe("m-claude")
      expect(handoffAnim.toMemberId).toBe("m-coder")
      expect(handoffAnim.durationMs).toBeGreaterThanOrEqual(2000)
      expect(handoffAnim.durationMs).toBeLessThanOrEqual(3000)

      // Walk out carries paper towards target desk
      const outSample = sampleHandoffWalk(handoffAnim, [-2, 0, -1], [2, 0, 1], start + 700, false)
      expect(outSample.phase).toBe("walk_out")
      expect(outSample.hasPaper).toBe(true)
      expect(outSample.position[0]).toBeGreaterThan(-2)

      // Walk back returns without paper
      const backSample = sampleHandoffWalk(handoffAnim, [-2, 0, -1], [2, 0, 1], start + 1900, false)
      expect(backSample.phase).toBe("walk_back")
      expect(backSample.hasPaper).toBe(false)
    }

    // Duplicate message.posted for the same handoff is deduplicated
    const duplicateMessageHandoff: StreamEvent = {
      seq: 2,
      id: "ev-handoff-dup",
      version: 1,
      type: "message.posted",
      actor: "claude",
      channel_id: "ch-general",
      ts: new Date(start).toISOString(),
      payload: {
        id: "msg-h1",
        channel_id: "ch-general",
        author_id: "m-claude",
        body: "@coder implement characters",
        mentions: ["m-coder"],
        handoff: { request_id: "req-1", from: "claude", to: "coder", depth: 1 },
        created_at: new Date(start).toISOString(),
      },
    }
    queue = enqueueOfficeEvent(queue, duplicateMessageHandoff, { members, now: start + 50 })
    expect(queue.items).toHaveLength(1)

    // Merge event via approval.resolved with option === "merge"
    const mergeEvent: StreamEvent = {
      seq: 3,
      id: "ev-merge-1",
      version: 1,
      type: "approval.resolved",
      actor: "director",
      channel_id: "ch-general",
      ts: new Date(start + 100).toISOString(),
      payload: {
        id: "ap-99",
        run_id: "run-99",
        channel_id: "ch-general",
        requested_by: "m-coder",
        title: "Merge branch",
        detail: "",
        options: [],
        state: "resolved",
        resolution: { option: "merge", by: "m-director", at: new Date(start + 100).toISOString() },
      },
    }
    queue = enqueueOfficeEvent(queue, mergeEvent, { members, now: start + 100 })
    expect(queue.items).toHaveLength(2)
    const mergeAnim = queue.items[1]!
    expect(mergeAnim.kind).toBe("merge")
    if (mergeAnim.kind === "merge") {
      expect(mergeAnim.memberId).toBe("m-coder")
      const pop = sampleMergePop(mergeAnim, start + 460, false)
      expect(pop.scale).toBeGreaterThan(1)
      expect(pop.opacity).toBe(1)
    }

    // Pruning after HANDOFF_DURATION_MS removes expired animations
    const afterAll = pruneAnimationQueue(queue, start + HANDOFF_DURATION_MS + MERGE_POP_DURATION_MS + 500)
    expect(afterAll.items).toHaveLength(0)
  })

  it("renders task board sticky notes, side-wall lane meter bars, day/night lighting, quota note, and clickable approval card", async () => {
    const lanes: Lane[] = [
      {
        id: "claude/opus",
        cli: "claude",
        cost_class: "premium",
        capacity: 2,
        running: 1,
        health: "available",
        windows: [{ name: "5h", used_pct: 35, source: "cli-log" }],
        runs_today: 2,
      },
      {
        id: "codex/default",
        cli: "codex",
        cost_class: "standard",
        capacity: 1,
        running: 0,
        health: "exhausted",
        windows: [{ name: "5h", used_pct: 100, source: "error", resets_at: "2026-10-18T17:15:00.000Z" }],
        runs_today: 6,
      },
    ]
    const runs: Run[] = [
      {
        id: "run-wait",
        channel_id: "ch-general",
        trigger_message_id: "msg-1",
        agent_id: "m-claude",
        lane_id: "claude/opus",
        mode: "write",
        state: "waiting_approval",
        started_at: new Date(now - 60_000).toISOString(),
      },
    ]
    const approvals: Approval[] = [
      {
        id: "ap-wait",
        run_id: "run-wait",
        channel_id: "ch-general",
        requested_by: "m-claude",
        title: "Ship 3D characters",
        detail: "Adds low-poly figures",
        options: [{ key: "merge", label: "Merge", style: "primary" }],
        state: "pending",
      },
    ]
    const events: StreamEvent[] = [
      {
        seq: 10,
        id: "ev-h",
        version: 1,
        type: "message.handoff",
        actor: "claude",
        ts: new Date(now).toISOString(),
        payload: { from: "claude", to: "coder", request_id: "req-10" },
      },
    ]

    const desks = deriveOfficeDesks({ members, runs, approvals, lanes, now })
    expect(deriveTaskBoardNotes(desks)).toHaveLength(1)
    expect(deriveTaskBoardNotes(desks)[0]?.title).toBe("Ship 3D characters")
    expect(deriveLaneMeterBars(lanes, "light")).toHaveLength(2)

    const dayLight = deriveTimeOfDayLighting(new Date(2026, 9, 18, 13, 0, 0).getTime(), "light")
    const nightLight = deriveTimeOfDayLighting(new Date(2026, 9, 18, 23, 0, 0).getTime(), "dark")
    expect(dayLight.period).toBe("day")
    expect(nightLight.period).toBe("night")
    expect(dayLight.keyIntensity).toBeGreaterThan(nightLight.keyIntensity)

    const onOpenApproval = vi.fn()
    await renderScene3D({ desks, lanes, runs, events, onOpenApproval })

    expect(screen.getByTestId("office3d-task-board")).toHaveTextContent("Ship 3D characters")
    expect(screen.getByTestId("lane-bar3d-claude/opus")).toHaveAttribute("data-health", "available")
    expect(screen.getByTestId("lane-bar3d-codex/default")).toHaveAttribute("data-health", "exhausted")
    expect(screen.getByTestId("quota-note3d-m-coder")).toHaveTextContent("back at 17:15")
    expect(screen.getByTestId("handoff-walk3d-anim-ev-h")).toHaveTextContent("@claude -> @coder")

    fireEvent.click(screen.getByTestId("approval-card3d-m-claude"))
    expect(onOpenApproval).toHaveBeenCalledWith(expect.objectContaining({ approvalChannelId: "ch-general" }))
    expect(screen.getByTestId("mini-approval-card")).toHaveTextContent("Ship 3D characters")
  })

  it("opens the side panel on Enter for the focused desk and closes it on Escape, restoring focus", async () => {
    await renderScene3D({ webglAvailable: true })
    const surface = screen.getByTestId("office3d-canvas")
    surface.focus()
    expect(screen.queryByRole("complementary")).toBeNull()

    fireEvent.keyDown(surface, { key: "Tab" })
    fireEvent.keyDown(surface, { key: "Enter" })
    const panel = screen.getByRole("complementary")
    expect(panel).toBeVisible()
    expect(panel).toHaveAccessibleName(/details$/)

    fireEvent.keyDown(document.body, { key: "Escape" })
    expect(screen.queryByRole("complementary")).toBeNull()
    expect(document.activeElement).toBe(surface)

    fireEvent.keyDown(surface, { key: "Tab" })
    fireEvent.keyDown(surface, { key: " " })
    expect(screen.getByRole("complementary")).toBeVisible()
  })

  it("renders on demand while idle and keeps drawing while someone is working", async () => {
    expect(OFFICE_MAX_DPR).toBe(1.5)
    await renderScene3D({ webglAvailable: true, reducedMotion: false })
    expect(screen.getByTestId("office3d-canvas")).toHaveAttribute("data-render", "demand")
  })

  it("keeps the 3D view rendering while an agent is working", async () => {
    const runs: Run[] = [
      {
        id: "run-work",
        channel_id: "ch-general",
        trigger_message_id: "msg-w",
        agent_id: "m-claude",
        lane_id: "claude/opus",
        mode: "write",
        state: "running",
        started_at: new Date(now - 30_000).toISOString(),
      },
    ]
    const desks = deriveOfficeDesks({ members, runs, approvals: [], lanes: [], now })
    await renderScene3D({ desks, runs, webglAvailable: true, reducedMotion: false })
    expect(screen.getByTestId("office3d-canvas")).toHaveAttribute("data-render", "always")
  })

  it("offers the zone menu, Fit all and no zoom buttons next to the 3D canvas, and keeps the orbit keys working", async () => {
    await renderScene3D({ webglAvailable: true })
    const menu = screen.getByRole("combobox", { name: "Jump to area" })
    fireEvent.focus(menu)
    expect(within(screen.getByRole("listbox", { name: "Areas" })).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Engineering",
      "Director",
    ])
    expect(screen.queryByRole("button", { name: "Zoom in" })).toBeNull()

    fireEvent.mouseDown(screen.getByRole("option", { name: "Engineering" }))
    expect(menu).toHaveValue("")
    fireEvent.click(screen.getByRole("button", { name: "Fit all" }))
    fireEvent.keyDown(screen.getByTestId("office3d-canvas"), { key: "ArrowLeft" })
    fireEvent.keyDown(screen.getByTestId("office3d-canvas"), { key: "+" })
    expect(screen.getByTestId("office3d-canvas")).toBeInTheDocument()
  })

  it("closes the fallback side panel on Escape and returns focus to the desk button", async () => {
    await renderScene3D()
    const button = screen.getByTestId("fallback-desk-m-claude")
    button.focus()
    fireEvent.click(button)
    expect(screen.getByRole("complementary", { name: "Claude details" })).toBeVisible()
    fireEvent.keyDown(document.body, { key: "Escape" })
    expect(screen.queryByRole("complementary")).toBeNull()
    expect(document.activeElement).toBe(button)
  })

  it("places every zone label inside its own zone and outside the others, and the Director label in front of the rug", () => {
    const roster: Member[] = [
      ...members,
      { id: "m-rev", kind: "agent", handle: "reviewer", display_name: "Reviewer", presence: "online", agent: { lanes: ["claude/opus"] } },
      { id: "m-cx", kind: "agent", handle: "codex", display_name: "Codex", presence: "online" },
    ]
    const desks = deriveOfficeDesks({ members: roster, runs: [], approvals: [], lanes: [], now })
    const room = layoutRoom(desks, { departments })
    expect(room.zones.length).toBeGreaterThan(1)
    const inside = (rect: { x: number; z: number; w: number; d: number }, p: { x: number; z: number }) =>
      Math.abs(p.x - rect.x) <= rect.w / 2 && Math.abs(p.z - rect.z) <= rect.d / 2
    const worlds = room.zones.map((zone) => ({ zone, rect: toWorld(zone, room.width, room.height) }))
    for (const { zone, rect } of worlds) {
      const label = zoneLabelAnchor(rect)
      expect(inside(rect, label), zone.id).toBe(true)
      for (const other of worlds) {
        if (other.zone.id !== zone.id) expect(inside(other.rect, label), `${zone.id} in ${other.zone.id}`).toBe(false)
      }
      for (const seat of room.seats) {
        const desk = toWorld({ x: seat.x, y: seat.y, w: DESK_W * seat.scale, h: DESK_H * seat.scale }, room.width, room.height)
        expect(inside(desk, label), `${zone.id} over desk`).toBe(false)
      }
    }

    expect(room.rug).not.toBeNull()
    const rug = toWorld(room.rug as NonNullable<typeof room.rug>, room.width, room.height)
    const dirLabel = directorLabelAnchor(rug)
    expect(dirLabel.z).toBeGreaterThan(rug.z + rug.d / 2)
    expect(Math.abs(dirLabel.x - rug.x)).toBeLessThan(rug.w / 2)
    for (const { rect } of worlds) expect(inside(rect, dirLabel)).toBe(false)
  })
})

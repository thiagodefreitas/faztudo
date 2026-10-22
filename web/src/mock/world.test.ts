import { describe, expect, it } from "vitest"
import { isUlid } from "../lib/id"
import { ManualClock } from "./clock"
import { handleMock } from "./http"
import { IDS } from "./ids"
import { APPROVAL_READY, FAIL_LINE, LIVE_PASS, SAMPLE_DIFF } from "./script"
import { MockWorld } from "./world"

function world() {
  const clock = new ManualClock()
  return { clock, world: new MockWorld(clock) }
}

describe("mock world", () => {
  it("serves prompt context for a run", () => {
    const { world: mock } = world()
    const posted = mock.postMessage(IDS.dev, { body: "@coder explain café" })
    if (!posted.ok) throw new Error("post failed")
    const runs = mock.getRuns(IDS.dev)
    if (!runs.ok) throw new Error("runs unavailable")
    const run = runs.data.find((item) => item.trigger_message_id === posted.data.id)
    if (!run) throw new Error("run missing")
    const response = handleMock(mock, "GET", new URL(`http://localhost/api/v1/runs/${run.id}/prompt`))
    expect(response.status).toBe(200)
    expect(JSON.stringify(response.body)).toContain("explain café")
  })

  it("uses synthetic ulids", () => {
    for (const id of Object.values(IDS)) expect(isUlid(id)).toBe(true)
  })

  it("streams a coder run, then waits for an approval", () => {
    const { clock, world: mock } = world()
    const events: string[] = []
    mock.subscribe(0, (event) => events.push(`${event.seq}:${event.type}`))
    const before = events.length
    const posted = mock.postMessage(IDS.dev, { body: "@coder add a lane health chip", idempotency_key: "k1" })
    expect(posted.ok).toBe(true)
    if (!posted.ok) return
    const again = mock.postMessage(IDS.dev, { body: "@coder add a lane health chip", idempotency_key: "k1" })
    expect(again.ok && again.data.id).toBe(posted.data.id)

    clock.advance(3000)
    const runs = mock.getRuns(IDS.dev, "waiting_approval")
    expect(runs.ok).toBe(true)
    if (!runs.ok) return
    const live = runs.data.find((run) => run.trigger_message_id === posted.data.id)
    expect(live?.lane_id).toBe("codex/default")
    expect(live?.state).toBe("waiting_approval")
    const output = live ? mock.getOutput(live.id) : null
    expect(output?.ok && output.data.lines.map((line) => line.text).join("")).toContain(APPROVAL_READY)
    const approvals = mock.getApprovals("pending")
    expect(approvals.some((approval) => approval.run_id === live?.id)).toBe(true)

    const replay: number[] = []
    mock.subscribe(0, (event) => replay.push(event.seq))
    expect(new Set(replay).size).toBe(replay.length)
    expect(events.length).toBeGreaterThan(before)
  })

  it("fails verification for a reviewer mention", () => {
    const { clock, world: mock } = world()
    const posted = mock.postMessage(IDS.dev, { body: "@reviewer look at the branch" })
    expect(posted.ok).toBe(true)
    if (!posted.ok) return
    clock.advance(3000)
    const runs = mock.getRuns(IDS.dev, "failed")
    expect(runs.ok).toBe(true)
    if (!runs.ok) return
    const failed = runs.data.find((run) => run.trigger_message_id === posted.data.id)
    expect(failed?.verification?.ok).toBe(false)
    expect(failed?.verification?.detail).toContain(FAIL_LINE)
    expect(failed?.failure_class).toBe("semantic")
  })

  it("finishes a pushed run with a passing verification and a diff", () => {
    const { clock, world: mock } = world()
    const posted = mock.postMessage(IDS.dev, { body: "@coder ship the chip" })
    if (!posted.ok) throw new Error("post failed")
    clock.advance(3000)
    const pending = mock.getApprovals("pending").find((approval) => approval.title.startsWith("Push branch"))
    if (!pending) throw new Error("missing approval")
    const resolved = mock.resolveApproval(pending.id, { option: "push" })
    expect(resolved.ok && resolved.data.state).toBe("resolved")
    clock.advance(1000)
    const runId = pending.run_id
    if (!runId) throw new Error("missing run")
    const run = mock.getRun(runId)
    expect(run.ok && run.data.state).toBe("done")
    expect(run.ok && run.data.verification).toEqual({ ok: true, detail: LIVE_PASS })
    const diff = mock.getDiff(runId)
    expect(diff.ok && diff.data.diff).toBe(SAMPLE_DIFF)
  })

  it("switches lanes when the first lane is exhausted", () => {
    const { clock, world: mock } = world()
    const patched = mock.patchLane("codex/default", { health_override: "exhausted" })
    expect(patched.ok && patched.data.health).toBe("exhausted")
    const seen: string[] = []
    mock.subscribe(mock.getChannels()[0] ? 10_000 : 0, () => undefined)
    // Subscribe from the current end so only the new switch is observed.
    const cursor = mock.getMe() ? 0 : 0
    void cursor
    const types: string[] = []
    mock.subscribe(Number.MAX_SAFE_INTEGER, () => undefined)
    mock.subscribe(0, (event) => {
      if (event.type === "lane.switched") types.push(event.type)
      seen.push(event.type)
    })
    types.length = 0
    seen.length = 0
    mock.postMessage(IDS.dev, { body: "@coder try the fallback" })
    clock.advance(300)
    const runs = mock.getRuns(IDS.dev)
    if (!runs.ok) throw new Error("runs")
    const live = runs.data.find((run) => run.state === "queued" || run.state === "running")
    expect(live?.lane_id).toBe("claude/opus")
    expect(seen).toContain("lane.switched")
  })

  it("serves the http error shape and clears unread", () => {
    const { world: mock } = world()
    const missing = handleMock(mock, "GET", new URL("http://127.0.0.1/api/v1/runs/missing"))
    expect(missing.status).toBe(404)
    expect(missing.body).toEqual({ error: { code: "not_found", message: "run not found" } })
    const channels = handleMock(mock, "GET", new URL("http://127.0.0.1/api/v1/channels"))
    expect(channels.status).toBe(200)
    const list = channels.body as Array<{ id: string; unread: number; last_seq?: number }>
    const general = list.find((channel) => channel.id === IDS.general)
    expect(general?.unread).toBe(2)
    const read = handleMock(mock, "POST", new URL(`http://127.0.0.1/api/v1/channels/${IDS.general}/read`), JSON.stringify({ seq: general?.last_seq }))
    expect(read.status).toBe(200)
    const after = handleMock(mock, "GET", new URL("http://127.0.0.1/api/v1/channels"))
    const updated = (after.body as Array<{ id: string; unread: number }>).find((channel) => channel.id === IDS.general)
    expect(updated?.unread).toBe(0)
    const health = handleMock(mock, "GET", new URL("http://127.0.0.1/api/v1/health"))
    expect(health.body).toMatchObject({ ok: true, version: "0.0.0-mock" })
    const head = handleMock(mock, "GET", new URL("http://127.0.0.1/api/v1/stream/head"))
    expect(head.status).toBe(200)
    expect((head.body as { seq: number }).seq).toBeGreaterThan(0)
  })

  it("patches channel settings and rejects a non-git repo path", () => {
    const { world: mock } = world()
    const url = new URL(`http://x/api/v1/channels/${IDS.dev}`)
    const ok = handleMock(mock, "PATCH", url, JSON.stringify({ repo_path: "/home/me/repo", test_command: "go test ./..." }))
    expect(ok.status).toBe(200)
    expect(ok.body).toMatchObject({ repo_path: "/home/me/repo", test_command: "go test ./..." })
    const bad = handleMock(mock, "PATCH", url, JSON.stringify({ repo_path: "/tmp/not-a-repo" }))
    expect(bad.status).toBe(400)
    expect(bad.body).toMatchObject({ error: { message: "repo_path is not a git work tree" } })
  })

  it("keeps thread replies out of the channel list and counts them on the root", () => {
    const { world: mock } = world()
    const root = mock.postMessage(IDS.dev, { body: "root" })
    if (!root.ok) throw new Error("post failed")
    const reply = mock.postMessage(IDS.dev, { body: "reply", thread_id: root.data.id })
    if (!reply.ok) throw new Error("reply failed")
    const nested = mock.postMessage(IDS.dev, { body: "nested", thread_id: reply.data.id })
    expect(nested.ok && nested.data.thread_id).toBe(root.data.id)
    const list = mock.getMessages(IDS.dev)
    if (!list.ok) throw new Error("list failed")
    expect(list.data.some((message) => message.thread_id)).toBe(false)
    expect(list.data.find((message) => message.id === root.data.id)?.reply_count).toBe(2)
    const thread = mock.getThread(root.data.id)
    expect(thread.ok && thread.data.replies).toHaveLength(2)
    expect(mock.postMessage(IDS.general, { body: "x", thread_id: root.data.id }).ok).toBe(false)
  })

  it("routes a DM message to its sole agent without a mention", () => {
    const { clock, world: mock } = world()
    const created = handleMock(
      mock,
      "POST",
      new URL("http://x/api/v1/channels"),
      JSON.stringify({ name: "dm-ada-coder", kind: "direct", visibility: "direct", member_ids: [IDS.ada, IDS.coder] }),
    )
    expect(created.status).toBe(200)
    const dm = created.body as { id: string }
    const posted = mock.postMessage(dm.id, { body: "please add a chip" })
    if (!posted.ok) throw new Error("post failed")
    clock.advance(300)
    const runs = mock.getRuns(dm.id)
    expect(runs.ok && runs.data.some((run) => run.trigger_message_id === posted.data.id && run.agent_id === IDS.coder)).toBe(true)
    const quiet = mock.postMessage(IDS.dev, { body: "no mention in a team channel" })
    if (!quiet.ok) throw new Error("post failed")
    const after = mock.getRuns(IDS.dev)
    expect(after.ok && after.data.some((run) => run.trigger_message_id === quiet.data.id)).toBe(false)
  })

  it("searches message bodies with match markers and scopes to a channel", () => {
    const { world: mock } = world()
    const posted = mock.postMessage(IDS.dev, { body: "zebra crossing plan" })
    if (!posted.ok) throw new Error("post failed")
    const all = mock.search("ZEBRA", undefined)
    expect(all.ok && all.data.map((hit) => hit.message.id)).toEqual([posted.data.id])
    expect(all.ok && all.data[0]?.snippet).toBe("\u0001zebra\u0002 crossing plan")
    const other = mock.search("zebra", IDS.general)
    expect(other.ok && other.data).toEqual([])
    const none = mock.search("   ", undefined)
    expect(none.ok && none.data).toEqual([])
  })

  it("pins and unpins a message, once", () => {
    const { world: mock } = world()
    const events: string[] = []
    mock.subscribe(0, (event) => events.push(event.type))
    const posted = mock.postMessage(IDS.dev, { body: "keep this" })
    if (!posted.ok) throw new Error("post failed")
    expect(mock.setPin(posted.data.id, true).ok).toBe(true)
    expect(mock.setPin(posted.data.id, true).ok).toBe(true)
    const pins = mock.getPins(IDS.dev)
    expect(pins.ok && pins.data.map((pin) => pin.message_id)).toEqual([posted.data.id])
    expect(events.filter((type) => type === "message.pinned")).toHaveLength(1)
    mock.setPin(posted.data.id, false)
    const after = mock.getPins(IDS.dev)
    expect(after.ok && after.data).toEqual([])
    expect(mock.setPin("missing", true).ok).toBe(false)
  })

  it("makes and deletes app routines and keeps the ones from lanes.toml", () => {
    const { world: mock } = world()
    const input = { name: "Check the build", prompt: "Check the build.", persona: "coder", channel: "general", schedule: "0 9 * * 1-5" }
    const made = mock.createRoutine(input)
    expect(made.ok && made.status).toBe(201)
    expect(made.ok && made.data).toMatchObject({ handle: "check-the-build", source: "app", enabled: true, persona: "coder", channel: "general" })
    const again = mock.createRoutine(input)
    expect(again.ok && again.data.handle).toBe("check-the-build-2")

    expect(mock.createRoutine({ ...input, persona: "nobody" }).ok).toBe(false)
    expect(mock.createRoutine({ ...input, channel: "nowhere" }).ok).toBe(false)
    expect(mock.createRoutine({ ...input, schedule: "every day" }).ok).toBe(false)
    const clash = mock.createRoutine({ ...input, name: "Daily debrief" })
    expect(clash.ok).toBe(false)
    expect(!clash.ok && clash.status).toBe(409)

    const refused = mock.deleteRoutine("daily-debrief")
    expect(!refused.ok && refused.status).toBe(409)
    expect(mock.deleteRoutine("check-the-build").ok).toBe(true)
    expect(mock.getRoutines().map((item) => item.handle)).toEqual(["daily-debrief", "check-the-build-2"])
    expect(mock.deleteRoutine("check-the-build").ok).toBe(false)
  })
})

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
  })
})

import { QueryClient } from "@tanstack/react-query"
import { describe, expect, it, vi } from "vitest"
import type { Message, OutputLine, StreamEvent } from "../types"
import { applyEvent } from "./cache"
import { qk } from "./keys"

function outputEvent(seq: number): StreamEvent {
  return {
    seq, id: `event-${seq}`, version: 1, type: "run.output", actor: "agent",
    channel_id: "channel-0", ts: "2026-10-18T12:00:00.000Z",
    payload: { run_id: "run-0", seq, stream: "stdout", text: `line ${seq}` },
  }
}

describe("applyEvent", () => {
  it("leaves unrelated query data untouched for an output event", () => {
    const qc = new QueryClient()
    const messages: Message[] = [{ id: "m", channel_id: "other", author_id: "human", body: "hello", mentions: [], created_at: "2026-10-18T12:00:00Z" }]
    const otherOutput: OutputLine[] = [{ seq: 1, stream: "stdout", text: "earlier" }]
    qc.setQueryData(qk.messages("other"), messages)
    qc.setQueryData(qk.output("other"), otherOutput)
    const beforeMessages = qc.getQueryState(qk.messages("other"))?.dataUpdatedAt
    const beforeOutput = qc.getQueryState(qk.output("other"))?.dataUpdatedAt
    applyEvent(qc, outputEvent(1))
    expect(qc.getQueryData(qk.messages("other"))).toBe(messages)
    expect(qc.getQueryData(qk.output("other"))).toBe(otherOutput)
    expect(qc.getQueryState(qk.messages("other"))?.dataUpdatedAt).toBe(beforeMessages)
    expect(qc.getQueryState(qk.output("other"))?.dataUpdatedAt).toBe(beforeOutput)
  })

  it("refreshes a comparison on its own events and candidate updates", () => {
    const qc = new QueryClient()
    const invalidate = vi.spyOn(qc, "invalidateQueries")
    qc.setQueryData(["compares", "channel-0"], [{ candidates: [{ run: { id: "run-0" } }, {}] }])
    applyEvent(qc, { ...outputEvent(1), type: "compare.started", payload: {} })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["compares", "channel-0"] })
    invalidate.mockClear()
    applyEvent(qc, { ...outputEvent(2), type: "run.updated", payload: { id: "run-0", channel_id: "channel-0", state: "done", lane_id: "codex/default" } })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["compares", "channel-0"] })
    invalidate.mockClear()
    applyEvent(qc, { ...outputEvent(3), type: "run.updated", payload: { id: "other-run", channel_id: "channel-0", state: "done", lane_id: "codex/default" } })
    expect(invalidate).not.toHaveBeenCalled()
  })

  it("keeps 2000 output events bounded with 40 cached channels of 200 messages", () => {
    const qc = new QueryClient()
    for (let channel = 0; channel < 40; channel++) {
      qc.setQueryData(qk.messages(`channel-${channel}`), Array.from({ length: 200 }, (_, index): Message => ({
        id: `${channel}-${index}`, channel_id: `channel-${channel}`, author_id: "human", body: "hello",
        mentions: [], created_at: "2026-10-18T12:00:00Z",
      })))
      qc.setQueryData(qk.output(`run-${channel}`), [] as OutputLine[])
    }
    let unrelatedWrites = 0
    const unsubscribe = qc.getQueryCache().subscribe((change) => {
      if (change?.type !== "updated") return
      const [kind, id] = change.query.queryKey
      if ((kind === "messages" || kind === "output") && id !== "run-0") unrelatedWrites++
    })
    const start = performance.now()
    for (let seq = 1; seq <= 2000; seq++) applyEvent(qc, outputEvent(seq))
    const elapsedMs = performance.now() - start
    unsubscribe()
    console.info(`cache output benchmark: 2000 events, 40x200 messages, ${elapsedMs.toFixed(1)} ms, ${unrelatedWrites} unrelated writes`)
    expect(qc.getQueryData<OutputLine[]>(qk.output("run-0"))).toHaveLength(2000)
    expect(unrelatedWrites).toBe(0)
  })
})

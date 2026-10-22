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

  it("applies lesson events to the cached list without a refetch", () => {
    const qc = new QueryClient()
    const invalidate = vi.spyOn(qc, "invalidateQueries")
    const lesson = { id: "l1", persona: "coder", channel_id: "", text: "Small diffs.", source_message_id: "", created_by: "ada", created_at: "t", updated_at: "t" }
    qc.setQueryData(qk.lessons, [])
    applyEvent(qc, { ...outputEvent(1), type: "lesson.added", payload: lesson })
    expect(qc.getQueryData(qk.lessons)).toEqual([lesson])
    applyEvent(qc, { ...outputEvent(2), type: "lesson.updated", payload: { ...lesson, text: "Tiny diffs." } })
    expect(qc.getQueryData(qk.lessons)).toEqual([{ ...lesson, text: "Tiny diffs." }])
    applyEvent(qc, { ...outputEvent(3), type: "lesson.removed", payload: lesson })
    expect(qc.getQueryData(qk.lessons)).toEqual([])
    expect(invalidate).not.toHaveBeenCalled()
  })

  it("applies suggestion events to the cached list without a refetch", () => {
    const qc = new QueryClient()
    const invalidate = vi.spyOn(qc, "invalidateQueries")
    const suggestion = { id: "s1", channel_id: "c1", persona: "reviewer", title: "Fix it", detail: "", evidence: ["a.go:1"], state: "open", created_at: "t" }
    applyEvent(qc, { ...outputEvent(1), type: "suggestion.created", payload: suggestion })
    expect(qc.getQueryData(qk.suggestions)).toBeUndefined()
    qc.setQueryData(qk.suggestions, [])
    applyEvent(qc, { ...outputEvent(2), type: "suggestion.created", payload: suggestion })
    expect(qc.getQueryData(qk.suggestions)).toEqual([suggestion])
    applyEvent(qc, { ...outputEvent(3), type: "suggestion.resolved", payload: { ...suggestion, state: "dismissed" } })
    expect(qc.getQueryData(qk.suggestions)).toEqual([{ ...suggestion, state: "dismissed" }])
    expect(invalidate).not.toHaveBeenCalled()
  })

  it("keeps lessons unloaded until the list is first fetched", () => {
    const qc = new QueryClient()
    applyEvent(qc, { ...outputEvent(1), type: "lesson.added", payload: { id: "l1" } })
    expect(qc.getQueryData(qk.lessons)).toBeUndefined()
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

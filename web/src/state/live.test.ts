import { describe, expect, it } from "vitest"
import { StreamClient, type StreamSocket } from "../api/stream"
import { startLiveStream } from "./live"

class FakeSocket implements StreamSocket {
  sent: string[] = []
  onopen: ((event?: unknown) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event?: unknown) => void) | null = null
  onerror: ((event?: unknown) => void) | null = null
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.onclose?.()
  }
}

describe("startLiveStream", () => {
  it("subscribes with the fetched head, then resumes from the last seen seq", async () => {
    const sockets: FakeSocket[] = []
    const retries: Array<() => void> = []
    const stop = startLiveStream({
      fetchHead: async () => 366000,
      makeClient: (afterSeq) =>
        new StreamClient({
          url: "ws://x",
          afterSeq,
          onEvent: () => {},
          connect: () => {
            const socket = new FakeSocket()
            sockets.push(socket)
            return socket
          },
          scheduleRetry: (fn) => {
            retries.push(fn)
            return () => {}
          },
        }),
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(sockets).toHaveLength(1)
    sockets[0]!.onopen?.()
    expect(JSON.parse(sockets[0]!.sent[0]!)).toEqual({ op: "subscribe", after_seq: 366000 })

    sockets[0]!.onmessage?.({ data: JSON.stringify({ seq: 366001, type: "notice" }) })
    sockets[0]!.onclose?.()
    retries[0]!()
    sockets[1]!.onopen?.()
    expect(JSON.parse(sockets[1]!.sent[0]!)).toEqual({ op: "subscribe", after_seq: 366001 })
    stop()
  })

  it("retries the head fetch and never subscribes from 0", async () => {
    let calls = 0
    const started: number[] = []
    const stop = startLiveStream({
      retryMs: 1,
      fetchHead: async () => {
        calls += 1
        if (calls === 1) throw new Error("offline")
        return 7
      },
      makeClient: (afterSeq) => {
        started.push(afterSeq)
        return { start: () => {}, stop: () => {} }
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(started).toEqual([7])
    stop()
  })
})

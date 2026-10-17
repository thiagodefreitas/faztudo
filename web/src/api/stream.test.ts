import { describe, expect, it } from "vitest"
import type { StreamEvent } from "../types"
import { StreamClient, type StreamSocket } from "./stream"

class FakeSocket implements StreamSocket {
  sent: string[] = []
  closed = false
  onopen: ((event?: unknown) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event?: unknown) => void) | null = null
  onerror: ((event?: unknown) => void) | null = null

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.onclose?.()
  }

  serverOpen(): void {
    this.onopen?.()
  }

  serverMessage(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) })
  }
}

function event(seq: number): StreamEvent {
  return {
    seq,
    id: `01EVENT${seq.toString().padStart(18, "0")}`.slice(0, 26),
    version: 1,
    type: "notice",
    actor: "system",
    ts: "2026-10-18T12:00:00.000Z",
    payload: { level: "info", text: `n${seq}` },
  }
}

describe("StreamClient", () => {
  it("resumes from after_seq and ignores a repeated seq", () => {
    const sockets: FakeSocket[] = []
    const seen: number[] = []
    const retries: Array<() => void> = []
    const client = new StreamClient({
      url: "ws://127.0.0.1/api/v1/stream",
      afterSeq: 5,
      onEvent: (item) => seen.push(item.seq),
      connect: () => {
        const socket = new FakeSocket()
        sockets.push(socket)
        return socket
      },
      scheduleRetry: (fn) => {
        retries.push(fn)
        return () => {
          retries.pop()
        }
      },
    })
    client.start()
    const first = sockets[0]
    if (!first) throw new Error("missing socket")
    first.serverOpen()
    expect(JSON.parse(first.sent[0] ?? "{}")).toEqual({ op: "subscribe", after_seq: 5 })

    first.serverMessage(event(5))
    first.serverMessage(event(6))
    first.serverMessage(event(6))
    first.serverMessage("not json")
    first.serverMessage(event(8))
    expect(seen).toEqual([6, 8])
    expect(client.getCursor()).toBe(8)

    first.close()
    retries[0]?.()
    const second = sockets[1]
    if (!second) throw new Error("missing resume socket")
    second.serverOpen()
    expect(JSON.parse(second.sent[0] ?? "{}")).toEqual({ op: "subscribe", after_seq: 8 })
  })

  it("does not reconnect after stop", () => {
    const sockets: FakeSocket[] = []
    let retries = 0
    const client = new StreamClient({
      url: "ws://127.0.0.1/api/v1/stream",
      afterSeq: 0,
      onEvent: () => undefined,
      connect: () => {
        const socket = new FakeSocket()
        sockets.push(socket)
        return socket
      },
      scheduleRetry: () => {
        retries += 1
        return () => undefined
      },
    })
    client.start()
    client.stop()
    expect(retries).toBe(0)
    expect(sockets[0]?.closed).toBe(true)
  })
})

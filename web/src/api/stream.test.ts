import { afterEach, describe, expect, it, vi } from "vitest"
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

  describe("backoff", () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    function setup(random = () => 1) {
      vi.useFakeTimers()
      const sockets: FakeSocket[] = []
      const client = new StreamClient({
        url: "ws://127.0.0.1/api/v1/stream",
        afterSeq: 3,
        onEvent: () => undefined,
        random,
        connect: () => {
          const socket = new FakeSocket()
          sockets.push(socket)
          return socket
        },
      })
      client.start()
      return { sockets, client }
    }

    it("backs off exponentially up to the cap", () => {
      const { sockets, client } = setup()
      const waits: number[] = []
      for (let i = 0; i < 8; i++) {
        const before = sockets.length
        sockets[before - 1]?.close()
        let waited = 0
        while (sockets.length === before) {
          vi.advanceTimersByTime(50)
          waited += 50
        }
        waits.push(waited)
      }
      expect(waits).toEqual([300, 600, 1200, 2400, 4800, 9600, 10000, 10000])
      client.stop()
    })

    it("applies jitter between half and full delay", () => {
      const { sockets, client } = setup(() => 0)
      sockets[0]?.close()
      vi.advanceTimersByTime(149)
      expect(sockets).toHaveLength(1)
      vi.advanceTimersByTime(1)
      expect(sockets).toHaveLength(2)
      client.stop()
    })

    it("resets the delay after a connection stays open for 5 s", () => {
      const { sockets, client } = setup()
      sockets[0]?.close()
      vi.advanceTimersByTime(300)
      sockets[1]?.close()
      vi.advanceTimersByTime(600)
      expect(sockets).toHaveLength(3)
      sockets[2]?.serverOpen()
      vi.advanceTimersByTime(5000)
      sockets[2]?.close()
      vi.advanceTimersByTime(299)
      expect(sockets).toHaveLength(3)
      vi.advanceTimersByTime(1)
      expect(sockets).toHaveLength(4)
      client.stop()
    })

    it("keeps the delay when a connection drops quickly", () => {
      const { sockets, client } = setup()
      sockets[0]?.close()
      vi.advanceTimersByTime(300)
      sockets[1]?.serverOpen()
      vi.advanceTimersByTime(1000)
      sockets[1]?.close()
      vi.advanceTimersByTime(599)
      expect(sockets).toHaveLength(2)
      vi.advanceTimersByTime(1)
      expect(sockets).toHaveLength(3)
      client.stop()
    })

    it("reconnects at once when the browser comes back online", () => {
      const { sockets, client } = setup()
      sockets[0]?.close()
      expect(sockets).toHaveLength(1)
      window.dispatchEvent(new Event("online"))
      expect(sockets).toHaveLength(2)
      sockets[1]?.serverOpen()
      expect(JSON.parse(sockets[1]?.sent[0] ?? "{}")).toEqual({ op: "subscribe", after_seq: 3 })
      client.stop()
    })

    it("reconnects at once when the page becomes visible", () => {
      const { sockets, client } = setup()
      sockets[0]?.close()
      document.dispatchEvent(new Event("visibilitychange"))
      expect(sockets).toHaveLength(2)
      client.stop()
    })

    it("ignores online while connected and after stop", () => {
      const { sockets, client } = setup()
      window.dispatchEvent(new Event("online"))
      expect(sockets).toHaveLength(1)
      sockets[0]?.close()
      client.stop()
      window.dispatchEvent(new Event("online"))
      vi.advanceTimersByTime(20_000)
      expect(sockets).toHaveLength(1)
    })
  })
})

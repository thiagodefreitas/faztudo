import type { StreamEvent } from "../types"

export type StreamStatus = "connecting" | "open" | "closed"

export interface StreamSocket {
  send: (data: string) => void
  close: () => void
  onopen: ((event?: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event?: unknown) => void) | null
  onerror: ((event?: unknown) => void) | null
}

export interface StreamClientOptions {
  url: string
  afterSeq: number
  onEvent: (event: StreamEvent) => void
  onStatus?: (status: StreamStatus) => void
  connect?: (url: string) => StreamSocket
  scheduleRetry?: (fn: () => void, ms: number) => () => void
  retryMs?: number
}

function defaultConnect(url: string): StreamSocket {
  // DOM WebSocket handler types are stricter than this small socket shape.
  return new WebSocket(url) as unknown as StreamSocket
}

function defaultSchedule(fn: () => void, ms: number): () => void {
  const id = setTimeout(fn, ms)
  return () => clearTimeout(id)
}

// Subscribes with after_seq, ignores a repeated seq, and sends the latest
// seq again when the socket drops.
export class StreamClient {
  private cursor: number
  private generation = 0
  private stopped = false
  private socket: StreamSocket | null = null
  private cancelRetry: (() => void) | null = null

  constructor(private readonly options: StreamClientOptions) {
    this.cursor = options.afterSeq
  }

  getCursor(): number {
    return this.cursor
  }

  start(): void {
    this.stopped = false
    this.open()
  }

  stop(): void {
    this.stopped = true
    this.generation += 1
    this.cancelRetry?.()
    this.cancelRetry = null
    const socket = this.socket
    this.socket = null
    socket?.close()
    this.options.onStatus?.("closed")
  }

  private open(): void {
    if (this.stopped) return
    const generation = ++this.generation
    this.options.onStatus?.("connecting")
    const connect = this.options.connect ?? defaultConnect
    const socket = connect(this.options.url)
    this.socket = socket
    socket.onopen = () => {
      if (this.stopped || generation !== this.generation) {
        socket.close()
        return
      }
      this.options.onStatus?.("open")
      socket.send(JSON.stringify({ op: "subscribe", after_seq: this.cursor }))
    }
    socket.onmessage = (event) => {
      if (generation !== this.generation) return
      const raw = typeof event.data === "string" ? event.data : ""
      if (!raw) return
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        return
      }
      if (!parsed || typeof parsed !== "object") return
      const seq = (parsed as { seq?: unknown }).seq
      if (typeof seq !== "number" || !Number.isFinite(seq)) return
      if (seq <= this.cursor) return
      this.cursor = seq
      this.options.onEvent(parsed as StreamEvent)
    }
    const retry = () => {
      if (this.stopped || generation !== this.generation) return
      this.options.onStatus?.("closed")
      const schedule = this.options.scheduleRetry ?? defaultSchedule
      this.cancelRetry = schedule(() => this.open(), this.options.retryMs ?? 400)
    }
    socket.onclose = retry
    socket.onerror = () => {
      socket.close()
    }
  }
}

export function streamUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:"
  return `${proto}//${location.host}/api/v1/stream`
}

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
  baseMs?: number
  maxMs?: number
  stableMs?: number
  random?: () => number
  now?: () => number
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
// seq again when the socket drops. Retries back off exponentially with
// jitter; the delay resets once a connection has stayed open for stableMs.
// Coming back online or visible reconnects at once.
export class StreamClient {
  private cursor: number
  private generation = 0
  private stopped = false
  private socket: StreamSocket | null = null
  private cancelRetry: (() => void) | null = null
  private attempt = 0
  private openedAt = 0
  private listening = false

  constructor(private readonly options: StreamClientOptions) {
    this.cursor = options.afterSeq
  }

  private readonly wake = () => {
    if (this.stopped || !this.cancelRetry) return
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return
    this.cancelRetry()
    this.cancelRetry = null
    this.open()
  }

  private listen(on: boolean): void {
    if (on === this.listening || typeof window === "undefined") return
    this.listening = on
    const act = on ? "addEventListener" : "removeEventListener"
    window[act]("online", this.wake)
    if (typeof document !== "undefined") document[act]("visibilitychange", this.wake)
  }

  private delay(): number {
    const base = this.options.baseMs ?? 300
    const max = this.options.maxMs ?? 10_000
    const ceiling = Math.min(max, base * 2 ** this.attempt)
    const jitter = 0.5 + 0.5 * (this.options.random ?? Math.random)()
    this.attempt += 1
    return Math.round(ceiling * jitter)
  }

  getCursor(): number {
    return this.cursor
  }

  start(): void {
    this.stopped = false
    this.attempt = 0
    this.listen(true)
    this.open()
  }

  stop(): void {
    this.stopped = true
    this.listen(false)
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
    this.cancelRetry = null
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
      this.openedAt = (this.options.now ?? Date.now)()
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
      const now = (this.options.now ?? Date.now)()
      if (this.openedAt && now - this.openedAt >= (this.options.stableMs ?? 5000)) this.attempt = 0
      this.openedAt = 0
      const schedule = this.options.scheduleRetry ?? defaultSchedule
      this.cancelRetry = schedule(() => this.open(), this.delay())
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

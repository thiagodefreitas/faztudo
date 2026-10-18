import type { StreamEvent } from "../types"

// A small fan-out for live events, for code that reacts to news (desktop
// notifications) and does not belong in the cache reducer.
type Listener = (event: StreamEvent) => void

const listeners = new Set<Listener>()

export function onStreamEvent(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function emitStreamEvent(event: StreamEvent): void {
  for (const listener of listeners) listener(event)
}

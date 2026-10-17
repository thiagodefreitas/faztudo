import { useSyncExternalStore } from "react"
import type { StreamStatus } from "../api/stream"

let status: StreamStatus = "closed"
const listeners = new Set<() => void>()

export function setStreamStatus(next: StreamStatus): void {
  if (status === next) return
  status = next
  for (const listener of listeners) listener()
}

export function useStreamStatus(): StreamStatus {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => status,
    () => "closed",
  )
}

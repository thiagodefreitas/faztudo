import { useSyncExternalStore } from "react"

let now = Date.now()
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | null = null

function tick(): void {
  now = Date.now()
  for (const listener of listeners) listener()
}

export function useNow(): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      if (!timer) timer = setInterval(tick, 1000)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0 && timer) {
          clearInterval(timer)
          timer = null
        }
      }
    },
    () => now,
    () => now,
  )
}

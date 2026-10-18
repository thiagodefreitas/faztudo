import { useSyncExternalStore } from "react"

// There are no server-side preferences yet, so these live in this browser.
const KEY = "faztudo.notify"

export interface NotifyPrefs {
  enabled: boolean
  muted: string[]
}

const DEFAULTS: NotifyPrefs = { enabled: false, muted: [] }

function read(): NotifyPrefs {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "null")
    if (!parsed || typeof parsed !== "object") return DEFAULTS
    const record = parsed as { enabled?: unknown; muted?: unknown }
    return {
      enabled: record.enabled === true,
      muted: Array.isArray(record.muted) ? record.muted.filter((id): id is string => typeof id === "string") : [],
    }
  } catch {
    return DEFAULTS
  }
}

let current = read()
const listeners = new Set<() => void>()

function write(next: NotifyPrefs): void {
  current = next
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // Private mode or a full disk: the choice lasts until the page closes.
  }
  for (const listener of listeners) listener()
}

export function getNotifyPrefs(): NotifyPrefs {
  return current
}

export function setNotificationsEnabled(enabled: boolean): void {
  write({ ...current, enabled })
}

export function toggleChannelMute(channelId: string): void {
  const muted = current.muted.includes(channelId)
    ? current.muted.filter((id) => id !== channelId)
    : [...current.muted, channelId]
  write({ ...current, muted })
}

export function useNotifyPrefs(): NotifyPrefs {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => current,
    () => DEFAULTS,
  )
}

// Test hook: re-read storage after a test changed it.
export function reloadNotifyPrefs(): void {
  current = read()
  for (const listener of listeners) listener()
}

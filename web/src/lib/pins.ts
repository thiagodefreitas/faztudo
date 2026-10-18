import { useCallback, useState } from "react"

// There are no server-side preferences yet, so pins live in this browser.
const KEY = "faztudo.pins"

export function readPins(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]")
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []
  } catch {
    return []
  }
}

function writePins(ids: string[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(ids))
  } catch {
    // Private mode or a full disk: the pin lasts until the page closes.
  }
}

export function togglePin(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id]
}

export function usePins(): { pins: string[]; toggle: (id: string) => void } {
  const [pins, setPins] = useState(readPins)
  const toggle = useCallback((id: string) => {
    setPins((current) => {
      const next = togglePin(current, id)
      writePins(next)
      return next
    })
  }, [])
  return { pins, toggle }
}

import { useSyncExternalStore } from "react"

export type ThemeChoice = "light" | "dark"

const KEY = "faztudo-theme"
const listeners = new Set<() => void>()

function systemDark(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches
}

export function getTheme(): ThemeChoice {
  try {
    const stored = localStorage.getItem(KEY)
    if (stored === "light" || stored === "dark") return stored
  } catch {
    // Storage can be blocked. Fall through to the system preference.
  }
  return systemDark() ? "dark" : "light"
}

function apply(choice: ThemeChoice): void {
  document.documentElement.classList.toggle("dark", choice === "dark")
}

function emit(): void {
  for (const listener of listeners) listener()
}

export function toggleTheme(): void {
  const next: ThemeChoice = getTheme() === "dark" ? "light" : "dark"
  try {
    localStorage.setItem(KEY, next)
  } catch {
    // The class still updates for this page.
  }
  apply(next)
  emit()
}

export function useTheme(): { choice: ThemeChoice; toggle: () => void } {
  const choice = useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getTheme,
    () => "light" as ThemeChoice,
  )
  return { choice, toggle: toggleTheme }
}

if (typeof document !== "undefined") {
  apply(getTheme())
  if (typeof matchMedia === "function") {
    const media = matchMedia("(prefers-color-scheme: dark)")
    media.addEventListener?.("change", () => {
      try {
        if (localStorage.getItem(KEY)) return
      } catch {
        return
      }
      apply(getTheme())
      emit()
    })
  }
}

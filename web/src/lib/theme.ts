import { useSyncExternalStore } from "react"

// What is painted. Other screens (office, palette) read this.
export type ThemeChoice = "light" | "dark"
// What the person picked. "system" follows prefers-color-scheme live.
export type ThemePreference = "system" | "light" | "dark"

export const THEME_ORDER: readonly ThemePreference[] = ["system", "light", "dark"]
export const THEME_LABEL: Record<ThemePreference, string> = { system: "System", light: "Light", dark: "Dark" }

const KEY = "faztudo-theme"
const listeners = new Set<() => void>()

function systemDark(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches
}

/** The stored preference. Nothing stored, or blocked storage, means "system". */
export function getThemePreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(KEY)
    if (stored === "light" || stored === "dark" || stored === "system") return stored
  } catch {
    // Storage can be blocked. Fall through to following the system.
  }
  return "system"
}

export function resolveTheme(preference: ThemePreference): ThemeChoice {
  if (preference === "system") return systemDark() ? "dark" : "light"
  return preference
}

/** The theme that is painted right now. */
export function getTheme(): ThemeChoice {
  return resolveTheme(getThemePreference())
}

export function nextTheme(preference: ThemePreference): ThemePreference {
  return THEME_ORDER[(THEME_ORDER.indexOf(preference) + 1) % THEME_ORDER.length] ?? "system"
}

function apply(): void {
  document.documentElement.classList.toggle("dark", getTheme() === "dark")
}

function emit(): void {
  for (const listener of listeners) listener()
}

export function setTheme(preference: ThemePreference): void {
  try {
    localStorage.setItem(KEY, preference)
  } catch {
    // The class still updates for this page.
  }
  apply()
  emit()
}

/** System, then Light, then Dark, then back to System. */
export function cycleTheme(): void {
  setTheme(nextTheme(getThemePreference()))
}

/** Flip between light and dark, and stop following the system. */
export function toggleTheme(): void {
  setTheme(getTheme() === "dark" ? "light" : "dark")
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useTheme(): {
  choice: ThemeChoice
  preference: ThemePreference
  cycle: () => void
  toggle: () => void
  set: (preference: ThemePreference) => void
} {
  const choice = useSyncExternalStore(subscribe, getTheme, () => "light" as ThemeChoice)
  const preference = useSyncExternalStore(subscribe, getThemePreference, () => "system" as ThemePreference)
  return { choice, preference, cycle: cycleTheme, toggle: toggleTheme, set: setTheme }
}

if (typeof document !== "undefined") {
  apply()
  if (typeof matchMedia === "function") {
    const media = matchMedia("(prefers-color-scheme: dark)")
    media.addEventListener?.("change", () => {
      if (getThemePreference() !== "system") return
      apply()
      emit()
    })
  }
}

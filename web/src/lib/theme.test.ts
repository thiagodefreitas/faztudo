import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cycleTheme, getTheme, getThemePreference, nextTheme, resolveTheme, setTheme, toggleTheme } from "./theme"

function mockSystem(dark: boolean) {
  const listeners = new Set<() => void>()
  const media = {
    matches: dark,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  }
  vi.stubGlobal("matchMedia", () => media)
  return media
}

describe("theme", () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.classList.remove("dark")
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("defaults to following the system", () => {
    mockSystem(true)
    expect(getThemePreference()).toBe("system")
    expect(getTheme()).toBe("dark")
    mockSystem(false)
    expect(getTheme()).toBe("light")
  })

  it("cycles System, Light, Dark and back", () => {
    expect(nextTheme("system")).toBe("light")
    expect(nextTheme("light")).toBe("dark")
    expect(nextTheme("dark")).toBe("system")
    mockSystem(false)
    cycleTheme()
    expect(getThemePreference()).toBe("light")
    cycleTheme()
    expect(getThemePreference()).toBe("dark")
    expect(document.documentElement.classList.contains("dark")).toBe(true)
    cycleTheme()
    expect(getThemePreference()).toBe("system")
    expect(document.documentElement.classList.contains("dark")).toBe(false)
  })

  it("keeps an explicit choice over the system", () => {
    mockSystem(true)
    setTheme("light")
    expect(resolveTheme(getThemePreference())).toBe("light")
    expect(document.documentElement.classList.contains("dark")).toBe(false)
  })

  it("toggle flips what is painted and stops following the system", () => {
    mockSystem(true)
    toggleTheme()
    expect(getThemePreference()).toBe("light")
    toggleTheme()
    expect(getThemePreference()).toBe("dark")
  })

  it("ignores an unknown stored value", () => {
    localStorage.setItem("faztudo-theme", "purple")
    expect(getThemePreference()).toBe("system")
  })
})

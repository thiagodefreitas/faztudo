import { describe, expect, it } from "vitest"
import { displayPct, formatCountdown, formatTokens } from "./lane-format"
import { summarizeLanes } from "./lane-health"
import type { Lane, LaneWindow } from "../types"

const now = Date.parse("2026-10-18T12:00:00.000Z")

function window(patch: Partial<LaneWindow>): LaneWindow {
  return { name: "5h", source: "cli-log", ...patch }
}

function lane(health: Lane["health"], windows: LaneWindow[]): Lane {
  return {
    id: "test/lane",
    cli: "custom",
    cost_class: "local",
    capacity: 1,
    running: 0,
    health,
    windows,
    runs_today: 0,
  }
}

describe("formatCountdown", () => {
  it("says unknown when there is no reset time", () => {
    expect(formatCountdown(undefined, now)).toBe("reset unknown")
    expect(formatCountdown("not a date", now)).toBe("reset unknown")
  })

  it("rounds an imminent reset up to soon", () => {
    expect(formatCountdown(new Date(now + 10_000).toISOString(), now)).toBe("reset soon")
    expect(formatCountdown(new Date(now - 60_000).toISOString(), now)).toBe("reset soon")
  })

  it("formats minutes, hours and days", () => {
    expect(formatCountdown(new Date(now + 25 * 60_000).toISOString(), now)).toBe("resets in 25m")
    expect(formatCountdown(new Date(now + 3 * 3_600_000 + 12 * 60_000).toISOString(), now)).toBe("resets in 3h 12m")
    expect(formatCountdown(new Date(now + 50 * 3_600_000).toISOString(), now)).toBe("resets in 2d 2h")
  })
})

describe("formatTokens", () => {
  it("says unknown when the value is absent", () => {
    expect(formatTokens(undefined)).toBe("unknown")
  })

  it("groups thousands", () => {
    expect(formatTokens(1200)).toBe("1,200")
    expect(formatTokens(31_000)).toBe("31,000")
    expect(formatTokens(2_500_000)).toBe("2,500,000")
  })
})

describe("displayPct", () => {
  it("hides the percent when health is unknown, never zero", () => {
    expect(displayPct(window({ used_pct: 40 }), "unknown")).toBeUndefined()
    expect(displayPct(window({ used_pct: 0 }), "unknown")).toBeUndefined()
  })

  it("hides the percent when used_pct is absent", () => {
    expect(displayPct(window({}), "available")).toBeUndefined()
    expect(displayPct(window({ used_pct: Number.NaN }), "conserve")).toBeUndefined()
  })

  it("keeps the percent otherwise", () => {
    expect(displayPct(window({ used_pct: 84.4 }), "conserve")).toBe(84.4)
    expect(displayPct(window({ used_pct: 0 }), "available")).toBe(0)
  })
})

describe("summarizeLanes", () => {
  it("reports unknown for an empty workspace", () => {
    expect(summarizeLanes([])).toEqual({ health: "unknown", count: 0, total: 0 })
  })

  it("picks the worst health and counts it", () => {
    const lanes = [
      lane("available", []),
      lane("conserve", []),
      lane("exhausted", []),
      lane("exhausted", []),
      lane("available", []),
    ]
    expect(summarizeLanes(lanes)).toEqual({ health: "exhausted", count: 2, total: 5 })
  })

  it("ranks unknown below states that block runs", () => {
    const lanes = [lane("unknown", []), lane("conserve", [])]
    expect(summarizeLanes(lanes).health).toBe("conserve")
  })

  it("treats an unmeasured lane as worse than a known available one", () => {
    const lanes = [lane("unknown", []), lane("available", [])]
    expect(summarizeLanes(lanes).health).toBe("unknown")
  })
})

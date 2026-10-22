import { describe, expect, it } from "vitest"
import { displayPct, formatCostAbout, formatCostEstimate, formatCountdown, formatTokens, sortLanes, sourceLabel, sparklinePath } from "./lane-format"
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

describe("lane history and cost", () => {
  it("draws a measured trend and leaves sparse history blank", () => {
    const readings = [
      { lane_id: "a", read_at: new Date(now - 60_000).toISOString(), window: window({ used_pct: 20 }) },
      { lane_id: "a", read_at: new Date(now).toISOString(), window: window({ used_pct: 80 }) },
    ]
    expect(sparklinePath(readings, now - 120_000, now)).toBe("M50.0 19.2 L100.0 4.8")
    expect(sparklinePath(readings.slice(0, 1), now - 120_000, now)).toBe("")
  })

  it("labels cost as an estimate only when priced", () => {
    expect(formatCostEstimate(undefined)).toBeUndefined()
    expect(formatCostEstimate(0.25)).toBe("about $0.25 today, estimate")
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

describe("sortLanes", () => {
  const make = (id: string, health: Lane["health"], cost_class: Lane["cost_class"]): Lane => ({ ...lane(health, []), id, cost_class })

  it("puts lanes that need attention first, worst first, then by cost class and id", () => {
    const sorted = sortLanes([
      make("local/a", "available", "local"),
      make("claude/b", "available", "premium"),
      make("codex/c", "conserve", "cheap"),
      make("grok/d", "exhausted", "standard"),
      make("kimi/e", "unavailable", "cheap"),
      make("claude/a", "available", "premium"),
    ])
    expect(sorted.map((item) => item.id)).toEqual(["grok/d", "kimi/e", "codex/c", "claude/a", "claude/b", "local/a"])
  })

  it("counts a recent error as needing attention", () => {
    const errored: Lane = { ...make("a/x", "available", "local"), last_error: { class: "transient", message: "x", at: "2026-10-18T11:00:00Z" } }
    expect(sortLanes([make("b/y", "available", "premium"), errored])[0]?.id).toBe("a/x")
  })
})

describe("sourceLabel and formatCostAbout", () => {
  it("uses plain words for sources", () => {
    expect(sourceLabel("cli-log")).toBe("measured")
    expect(sourceLabel("manual")).toBe("manual")
    expect(sourceLabel("probe")).toBe("probe")
  })

  it("rounds a cost and omits an unknown one", () => {
    expect(formatCostAbout(0.012)).toBe("about $0.01")
    expect(formatCostAbout(0.004)).toBe("about $0.0040")
    expect(formatCostAbout(undefined)).toBeUndefined()
  })
})

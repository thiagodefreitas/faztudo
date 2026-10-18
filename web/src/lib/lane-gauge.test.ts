import { describe, expect, it } from "vitest"
import { laneGauge, lanesChip } from "./lane-gauge"
import type { Lane, LaneWindow } from "../types"

const now = Date.parse("2026-10-18T12:00:00.000Z")

function lane(patch: Partial<Lane>): Lane {
  return { id: "claude/sonnet", cli: "claude", cost_class: "premium", capacity: 1, running: 0, health: "available", windows: [], runs_today: 0, ...patch }
}

function win(patch: Partial<LaneWindow>): LaneWindow {
  return { name: "5h", source: "cli-log", measured_at: "2026-10-18T11:55:00.000Z", ...patch }
}

describe("laneGauge", () => {
  it("shows the percent of the most recent window", () => {
    const g = laneGauge(lane({ windows: [win({ used_pct: 41.6 })] }), now)
    expect(g.text).toBe("42%")
    expect(g.health).toBe("available")
    expect(g.href).toEqual({ lane: "claude/sonnet" })
  })

  it("falls back to compact tokens when no percent is known", () => {
    const g = laneGauge(lane({ windows: [win({ tokens: 12_345 })] }), now)
    expect(g.text).toBe("12k tok")
  })

  it("says unknown, never zero, without a reading or with unknown health", () => {
    expect(laneGauge(lane({}), now).text).toBe("unknown")
    expect(laneGauge(lane({ health: "unknown", windows: [win({ used_pct: 0 })] }), now).text).toBe("unknown")
  })

  it("lists every window, source and age in the tooltip", () => {
    const g = laneGauge(
      lane({
        health: "conserve",
        health_reason: "week window high",
        windows: [
          win({ name: "5h", used_pct: 20, resets_at: "2026-10-18T14:30:00.000Z" }),
          win({ name: "week", used_pct: 91, source: "probe", measured_at: "2026-10-18T11:00:00.000Z" }),
        ],
      }),
      now,
    )
    expect(g.tooltip[0]).toBe("claude/sonnet: Conserve")
    expect(g.tooltip).toContain("week window high")
    expect(g.tooltip).toContain("5h 20%, resets in 2h 30m, cli-log, 5m ago")
    expect(g.tooltip).toContain("week 91%, reset unknown, probe, 1h ago")
  })

  it("names a lane with no windows in the tooltip", () => {
    expect(laneGauge(lane({}), now).tooltip).toContain("no usage reading")
  })
})

describe("lanesChip", () => {
  it("summarises the worst health for the phone chip", () => {
    const chip = lanesChip([lane({}), lane({ id: "b", health: "exhausted" })])
    expect(chip.health).toBe("exhausted")
    expect(chip.label).toBe("Lanes 1/2")
  })

  it("is plain Lanes with no lanes", () => {
    expect(lanesChip([]).label).toBe("Lanes")
  })
})

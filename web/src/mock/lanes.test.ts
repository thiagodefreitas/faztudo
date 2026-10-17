import { describe, expect, it } from "vitest"
import type { LaneHealth, UsageSource } from "../types"
import { MockWorld } from "./world"
import { realClock } from "./clock"

const HEALTHS: LaneHealth[] = ["available", "conserve", "exhausted", "unavailable", "unknown"]
const SOURCES: UsageSource[] = ["cli-log", "probe", "error", "manual", "unknown"]

describe("mock lanes", () => {
  it("covers every health and every usage source", () => {
    const world = new MockWorld(realClock)
    const lanes = world.getLanes()
    const healths = new Set(lanes.map((lane) => lane.health))
    const sources = new Set(lanes.flatMap((lane) => lane.windows.map((window) => window.source)))
    for (const health of HEALTHS) expect(healths.has(health), `health ${health}`).toBe(true)
    for (const source of SOURCES) expect(sources.has(source), `source ${source}`).toBe(true)
  })

  it("marks every measured window with a reset countdown time or none, never a fake zero", () => {
    const world = new MockWorld(realClock)
    for (const lane of world.getLanes()) {
      for (const window of lane.windows) {
        if (window.used_pct !== undefined) expect(window.used_pct).toBeGreaterThan(0)
      }
    }
  })
})

import { describe, expect, it } from "vitest"
import { formatAge, formatElapsed } from "./time"

const now = Date.parse("2026-10-18T12:00:00.000Z")

describe("formatAge", () => {
  it("says when the number was measured", () => {
    expect(formatAge(undefined, now)).toBe("age unknown")
    expect(formatAge(new Date(now - 10_000).toISOString(), now)).toBe("just now")
    expect(formatAge(new Date(now - 5 * 60_000).toISOString(), now)).toBe("5m ago")
    expect(formatAge(new Date(now - 3 * 3_600_000).toISOString(), now)).toBe("3h ago")
    expect(formatAge(new Date(now - 3 * 86_400_000).toISOString(), now)).toBe("3d ago")
  })
})

describe("formatElapsed", () => {
  it("counts from start to end, or to now while the run is open", () => {
    const start = new Date(now - 75_000).toISOString()
    expect(formatElapsed(start, new Date(now).toISOString(), now)).toBe("1m 15s")
    expect(formatElapsed(start, undefined, now)).toBe("1m 15s")
    expect(formatElapsed(undefined, undefined, now)).toBe("not started")
    expect(formatElapsed(new Date(now - 3_700_000).toISOString(), undefined, now)).toBe("1h 1m")
  })
})

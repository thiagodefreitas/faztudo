import { describe, expect, it } from "vitest"
import { nextRun, SCHEDULE_PRESETS } from "./schedule"

// Dates are built in local time, as nextRun works in the browser's zone.
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi)

describe("nextRun", () => {
  it("finds the next weekday morning", () => {
    // 2026-10-23 is a Friday: after 09:00 the next weekday run is Monday.
    expect(nextRun("0 9 * * 1-5", at(2026, 10, 23, 9, 0))).toEqual(at(2026, 10, 26, 9, 0))
    expect(nextRun("0 9 * * 1-5", at(2026, 10, 23, 8, 59))).toEqual(at(2026, 10, 23, 9, 0))
  })

  it("handles every day, a single weekday and steps", () => {
    expect(nextRun("0 18 * * *", at(2026, 10, 22, 19, 0))).toEqual(at(2026, 10, 23, 18, 0))
    expect(nextRun("0 9 * * 1", at(2026, 10, 22, 12, 0))).toEqual(at(2026, 10, 26, 9, 0))
    expect(nextRun("*/15 * * * *", at(2026, 10, 22, 12, 7))).toEqual(at(2026, 10, 22, 12, 15))
  })

  it("matches the day of the month or the weekday when both are set", () => {
    // The 1st is a Sunday in November 2026; Monday 2026-10-26 matches the weekday.
    expect(nextRun("0 9 1 * 1", at(2026, 10, 24, 0, 0))).toEqual(at(2026, 10, 26, 9, 0))
  })

  it("refuses what is not a valid expression", () => {
    expect(nextRun("", at(2026, 10, 22))).toBeNull()
    expect(nextRun("0 9 * *", at(2026, 10, 22))).toBeNull()
    expect(nextRun("61 9 * * *", at(2026, 10, 22))).toBeNull()
    expect(nextRun("0 25 * * *", at(2026, 10, 22))).toBeNull()
    expect(nextRun("a b c d e", at(2026, 10, 22))).toBeNull()
  })

  it("gives up on a day that never comes", () => {
    expect(nextRun("0 0 31 2 *", at(2026, 10, 22))).toBeNull()
  })

  it("accepts every preset", () => {
    for (const preset of SCHEDULE_PRESETS) expect(nextRun(preset.cron, at(2026, 10, 22))).not.toBeNull()
  })
})

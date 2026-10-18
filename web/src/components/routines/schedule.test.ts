import { describe, expect, it } from "vitest"
import { describeSchedule } from "./schedule"

describe("describeSchedule", () => {
  it("puts common schedules in words", () => {
    expect(describeSchedule("0 18 * * 1-5")).toBe("Weekdays at 18:00")
    expect(describeSchedule("30 8 * * *")).toBe("Every day at 08:30")
    expect(describeSchedule("5 9 * * mon-fri")).toBe("Weekdays at 09:05")
    expect(describeSchedule("*/15 * * * *")).toBe("Every 15 minutes")
    expect(describeSchedule("@daily")).toBe("Every day at 00:00")
    expect(describeSchedule("@hourly")).toBe("Every hour")
  })

  it("returns anything else as written", () => {
    expect(describeSchedule("0 9 13 * 5")).toBe("0 9 13 * 5")
    expect(describeSchedule("0 9,17 * * *")).toBe("0 9,17 * * *")
    expect(describeSchedule("every day")).toBe("every day")
  })
})

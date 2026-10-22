import { describe, expect, it } from "vitest"
import type { Lane, Member } from "../types"
import { laneAdvice, takeoverLane } from "./lane-advice"

const now = Date.parse("2026-10-22T12:00:00Z")
function lane(id: string, over: Partial<Lane> = {}): Lane {
  return { id, cli: "codex", cost_class: "standard", capacity: 1, running: 0, health: "available", windows: [], runs_today: 0, ...over } as Lane
}
const err = (cls: string, message: string) => ({ class: cls, message, at: new Date(now).toISOString() })
const coder = { id: "m1", kind: "agent", handle: "coder", display_name: "Coder", presence: "online", agent: { lanes: ["a", "b"] } } as Member

describe("laneAdvice", () => {
  it("tells a login failure to run the cli login", () => {
    const l = lane("a", { health: "unavailable", last_error: err("semantic", "not logged in: please login") })
    expect(laneAdvice(l, [l], [], now)).toBe('Run "codex login" in a terminal, then press Probe now.')
  })
  it("names the reset and the takeover lane when exhausted", () => {
    const a = lane("a", { health: "exhausted", windows: [{ name: "5h", resets_at: new Date(now + 2 * 3_600_000).toISOString(), source: "cli" } as never] })
    const b = lane("b")
    expect(laneAdvice(a, [a, b], [coder], now)).toBe("Out of quota (resets in 2h 0m). Work moves to b until then.")
  })
  it("omits the takeover when no chain has a healthy next lane", () => {
    const a = lane("a", { health: "exhausted" })
    expect(laneAdvice(a, [a], [coder], now)).toBe("Out of quota (reset time unknown).")
    expect(takeoverLane(a, [a, lane("b", { health: "exhausted" })], [coder])).toBeUndefined()
  })
  it("maps unavailable, transient and unknown errors", () => {
    const u = lane("a", { health: "unavailable", last_error: err("unavailable", "spawn ENOENT") })
    expect(laneAdvice(u, [u], [], now)).toContain("installed")
    const t = lane("a", { last_error: err("transient", "timeout") })
    expect(laneAdvice(t, [t], [], now)).toContain("temporary")
    const x = lane("a", { last_error: err("unknown", "boom") })
    expect(laneAdvice(x, [x], [], now)).toContain("faztudo doctor")
  })
  it("says nothing for a healthy lane without an error", () => {
    expect(laneAdvice(lane("a"), [], [], now)).toBeUndefined()
  })
})

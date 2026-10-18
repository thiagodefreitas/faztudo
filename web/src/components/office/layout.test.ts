import { describe, expect, it } from "vitest"
import type { Department, Member } from "../../types"
import { COMPACT_ROOM_W, DESK_H, DESK_W, layoutRoom, zonesOf } from "./layout"
import { deriveOfficeDesks } from "./state"

const now = Date.parse("2026-10-18T12:00:00.000Z")

function agent(handle: string, lane: string): Member {
  return {
    id: `m-${handle}`,
    kind: "agent",
    handle,
    display_name: handle,
    presence: "online",
    agent: { lanes: [lane], mode: "write" },
  }
}

function desksFor(handles: string[], humans = 1) {
  const members: Member[] = []
  for (let i = 0; i < humans; i += 1) {
    members.push({ id: `h-${i}`, kind: "human", handle: `person${i}`, display_name: `Person ${i}`, presence: "online" })
  }
  for (const handle of handles) members.push(agent(handle, `${handle === "coder" || handle === "reviewer" ? "codex" : handle}/default`))
  return deriveOfficeDesks({ members, runs: [], approvals: [], lanes: [], now })
}

const personas = ["coder", "reviewer", "architect", "writer"]
const clis = ["claude", "codex", "agy", "kimi", "opencode", "grok"]

describe("layoutRoom", () => {
  it("splits personas from raw CLIs and leaves the Director out of the zones", () => {
    const zones = zonesOf(desksFor([...personas, ...clis]))
    expect(zones.map((zone) => [zone.id, zone.desks.length])).toEqual([
      ["personas", 4],
      ["agents", 6],
    ])
    expect(zonesOf(desksFor(clis)).map((zone) => zone.id)).toEqual(["agents"])
  })

  it("groups desks by department when departments are present and keeps unassigned members in fallback zones", () => {
    const departments: Department[] = [
      {
        handle: "engineering",
        display_name: "Engineering",
        lead: "architect",
        members: ["coder", "reviewer"],
      },
      {
        handle: "docs",
        display_name: "Documentation",
        lead: "writer",
        members: [],
      },
    ]
    const desks = desksFor([...personas, ...clis])
    const zones = zonesOf(desks, departments)
    expect(zones.map((zone) => [zone.id, zone.label, zone.desks.map((d) => d.member.handle)])).toEqual([
      ["dept-engineering", "Engineering", ["architect", "coder", "reviewer"]],
      ["dept-docs", "Documentation", ["writer"]],
      ["agents", "Agents", clis],
    ])
  })

  it("seats every member once, in reading order, with the Director last and facing the room", () => {
    const desks = desksFor([...personas, ...clis])
    const room = layoutRoom(desks)
    expect(room.seats).toHaveLength(11)
    expect(new Set(room.seats.map((seat) => seat.desk.member.id)).size).toBe(11)
    expect(room.seats.slice(0, 4).map((seat) => seat.desk.member.handle)).toEqual(personas)
    expect(room.seats.at(-1)?.desk.isDirector).toBe(true)
    expect(room.seats.at(-1)?.scale).toBeGreaterThan(1)
    expect(room.seats.at(-1)?.facing).toBe("up")
  })

  it("groups desks in pods of four and keeps every desk inside the room without overlap", () => {
    const room = layoutRoom(desksFor([...personas, ...clis]))
    expect(room.zones.map((zone) => zone.pods.length)).toEqual([1, 2])
    for (const seat of room.seats) {
      const w = DESK_W * seat.scale
      const h = DESK_H * seat.scale
      expect(seat.x).toBeGreaterThanOrEqual(0)
      expect(seat.y).toBeGreaterThanOrEqual(0)
      expect(seat.x + w).toBeLessThanOrEqual(room.width)
      expect(seat.y + h).toBeLessThanOrEqual(room.height)
    }
    for (const [i, a] of room.seats.entries()) {
      for (const b of room.seats.slice(i + 1)) {
        const apart =
          a.x + DESK_W * a.scale <= b.x || b.x + DESK_W * b.scale <= a.x || a.y + DESK_H * a.scale <= b.y || b.y + DESK_H * b.scale <= a.y
        expect(apart).toBe(true)
      }
    }
  })

  it("reflows pods vertically on a compact phone width without horizontal overflow", () => {
    const room = layoutRoom(desksFor([...personas, ...clis]), { compact: true })
    expect(room.width).toBe(COMPACT_ROOM_W)
    expect(room.height).toBeGreaterThan(room.width)
    for (const zone of room.zones) {
      expect(zone.x).toBeGreaterThanOrEqual(0)
      expect(zone.x + zone.w).toBeLessThanOrEqual(room.width)
    }
  })

  it("fits 11 desks in a landscape room that suits a 1440x900 viewport", () => {
    const room = layoutRoom(desksFor([...personas, ...clis]))
    expect(room.width / room.height).toBeGreaterThan(1.5)
  })

  it("wraps extra pods and handles a room with no agents", () => {
    const many = layoutRoom(desksFor(Array.from({ length: 20 }, (_, i) => `claude-${i}`)))
    expect(many.seats).toHaveLength(21)
    expect(many.zones[0]?.pods).toHaveLength(5)
    const empty = layoutRoom([])
    expect(empty.seats).toHaveLength(0)
    expect(empty.rug).toBeNull()
  })
})

import type { Approval, Lane } from "../types"

// Resolved is final: a pending copy never replaces a resolved one, whichever
// side holds it. Otherwise the fetched list is the truth.
export function mergeApprovals(server: Approval[], local: Approval[]): Approval[] {
  const localById = new Map(local.map((item) => [item.id, item]))
  const seen = new Set<string>()
  const merged: Approval[] = []
  for (const item of server) {
    seen.add(item.id)
    const mine = localById.get(item.id)
    merged.push(mine && mine.state !== "pending" && item.state === "pending" ? mine : item)
  }
  for (const item of local) {
    if (!seen.has(item.id)) merged.push(item)
  }
  return merged
}

// The API decides which lanes exist. Stream readings only refine listed lanes.
export function mergeLanes(server: Lane[], local: Lane[]): Lane[] {
  const localById = new Map(local.map((item) => [item.id, item]))
  return server.map((item) => localById.get(item.id) ?? item)
}

export function mergeById<T extends { id: string }>(server: T[], local: T[]): T[] {
  const localById = new Map(local.map((item) => [item.id, item]))
  const seen = new Set<string>()
  const merged: T[] = []
  for (const item of server) {
    seen.add(item.id)
    merged.push(localById.get(item.id) ?? item)
  }
  for (const item of local) {
    if (!seen.has(item.id)) merged.push(item)
  }
  return merged
}

export function replaceById<T extends { id: string }>(list: T[], item: T): T[] {
  const index = list.findIndex((entry) => entry.id === item.id)
  if (index === -1) return [...list, item]
  const copy = list.slice()
  copy[index] = item
  return copy
}

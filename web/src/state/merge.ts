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

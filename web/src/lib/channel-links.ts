// A remark plugin: "#name" in text becomes a link to that channel when a
// channel with the name exists. Code, links and definitions are left alone.
export interface ChannelRef {
  id: string
  name: string
}

interface MdNode {
  type: string
  value?: string
  url?: string
  children?: MdNode[]
}

const SKIP = new Set(["code", "inlineCode", "link", "linkReference", "definition", "html"])
const TAG = /(^|[^\w&#/])#([a-z0-9][a-z0-9-]*)/gi

function split(value: string, byName: Map<string, ChannelRef>): MdNode[] | null {
  const out: MdNode[] = []
  let from = 0
  for (const match of value.matchAll(TAG)) {
    const name = (match[2] ?? "").replace(/-+$/, "")
    const channel = byName.get(name.toLowerCase())
    if (!channel) continue
    const start = (match.index ?? 0) + (match[1] ?? "").length
    if (start > from) out.push({ type: "text", value: value.slice(from, start) })
    out.push({ type: "link", url: `/c/${channel.id}`, children: [{ type: "text", value: `#${name}` }] })
    from = start + 1 + name.length
  }
  if (out.length === 0) return null
  if (from < value.length) out.push({ type: "text", value: value.slice(from) })
  return out
}

function walk(node: MdNode, byName: Map<string, ChannelRef>): void {
  if (!node.children || SKIP.has(node.type)) return
  const next: MdNode[] = []
  for (const child of node.children) {
    const replaced = child.type === "text" && child.value ? split(child.value, byName) : null
    if (replaced) next.push(...replaced)
    else {
      walk(child, byName)
      next.push(child)
    }
  }
  node.children = next
}

export function channelLinks(channels: ChannelRef[]) {
  const byName = new Map(channels.map((channel) => [channel.name.toLowerCase(), channel]))
  return () => (tree: MdNode) => {
    if (byName.size > 0) walk(tree, byName)
  }
}

// "/c/<id>" is how channelLinks addresses a channel.
export function channelIdOf(href: string | undefined): string | null {
  const match = /^\/c\/([^/?#]+)$/.exec(href ?? "")
  return match?.[1] ?? null
}

import type { Member } from "../types"

// Full class names so Tailwind can see them. Slots follow docs/design.md.
export interface Hue {
  disc: string
  edge: string
  text: string
}

const HUES: Hue[] = [
  { disc: "bg-agent-1-soft text-agent-1-fg", edge: "bg-agent-1", text: "text-agent-1" },
  { disc: "bg-agent-2-soft text-agent-2-fg", edge: "bg-agent-2", text: "text-agent-2" },
  { disc: "bg-agent-3-soft text-agent-3-fg", edge: "bg-agent-3", text: "text-agent-3" },
  { disc: "bg-agent-4-soft text-agent-4-fg", edge: "bg-agent-4", text: "text-agent-4" },
  { disc: "bg-agent-5-soft text-agent-5-fg", edge: "bg-agent-5", text: "text-agent-5" },
  { disc: "bg-agent-6-soft text-agent-6-fg", edge: "bg-agent-6", text: "text-agent-6" },
]

const HUMAN: Hue = { disc: "bg-line text-ink", edge: "bg-line", text: "text-muted" }

// Default CLIs keep the slot named in docs/design.md.
const BY_HANDLE: Record<string, number> = {
  claude: 0,
  codex: 1,
  agy: 2,
  antigravity: 2,
  kimi: 3,
  opencode: 4,
  grok: 5,
}

function hash(text: string): number {
  let value = 0
  for (const char of text) value = (value * 31 + char.charCodeAt(0)) >>> 0
  return value
}

export function hueFor(member: Pick<Member, "id" | "kind" | "handle"> | null | undefined): Hue {
  if (!member || member.kind !== "agent") return HUMAN
  const slot = BY_HANDLE[member.handle.toLowerCase()] ?? hash(member.id) % HUES.length
  return HUES[slot] ?? HUMAN
}

export function initialOf(name: string): string {
  return name.trim().charAt(0).toUpperCase() || "?"
}

import type { AgentInfo, Member } from "../types"

// Full class names so Tailwind can see them. Slots follow docs/design.md.
export interface Hue {
  disc: string
  edge: string
  text: string
  tile: string
  ink: string
}

const HUES: Hue[] = [
  { disc: "bg-agent-1-soft text-agent-1-fg", edge: "bg-agent-1", text: "text-agent-1", tile: "fill-agent-1-soft", ink: "text-agent-1-fg" },
  { disc: "bg-agent-2-soft text-agent-2-fg", edge: "bg-agent-2", text: "text-agent-2", tile: "fill-agent-2-soft", ink: "text-agent-2-fg" },
  { disc: "bg-agent-3-soft text-agent-3-fg", edge: "bg-agent-3", text: "text-agent-3", tile: "fill-agent-3-soft", ink: "text-agent-3-fg" },
  { disc: "bg-agent-4-soft text-agent-4-fg", edge: "bg-agent-4", text: "text-agent-4", tile: "fill-agent-4-soft", ink: "text-agent-4-fg" },
  { disc: "bg-agent-5-soft text-agent-5-fg", edge: "bg-agent-5", text: "text-agent-5", tile: "fill-agent-5-soft", ink: "text-agent-5-fg" },
  { disc: "bg-agent-6-soft text-agent-6-fg", edge: "bg-agent-6", text: "text-agent-6", tile: "fill-agent-6-soft", ink: "text-agent-6-fg" },
]

const HUMAN: Hue = { disc: "bg-line text-ink", edge: "bg-line", text: "text-muted", tile: "fill-line", ink: "text-ink" }

export type Cli = "claude" | "codex" | "agy" | "kimi" | "opencode" | "grok"
export type Role = "coder" | "reviewer" | "architect" | "writer" | "other"

// Default CLIs keep the slot named in docs/design.md.
const CLIS: Record<string, Cli> = {
  claude: "claude",
  codex: "codex",
  agy: "agy",
  antigravity: "agy",
  kimi: "kimi",
  opencode: "opencode",
  grok: "grok",
}

const SLOT: Record<Cli, number> = { claude: 0, codex: 1, agy: 2, kimi: 3, opencode: 4, grok: 5 }

const ROLES: Record<string, Role> = { coder: "coder", reviewer: "reviewer", architect: "architect", writer: "writer" }

export type AvatarMember = Pick<Member, "id" | "kind" | "handle"> & {
  agent?: Pick<AgentInfo, "lanes"> | undefined
}

function hash(text: string): number {
  let value = 0
  for (const char of text) value = (value * 31 + char.charCodeAt(0)) >>> 0
  return value
}

export interface Identity {
  // cli is null for an unknown agent, which gets the neutral character.
  cli: Cli | null
  // role is null for an agent that is a CLI itself, so it has no badge.
  role: Role | null
  slot: number
}

// A handle that names a CLI is that CLI. Any other handle is a persona and
// takes the character of the CLI of its first lane ("codex/default" is codex).
export function identityOf(member: AvatarMember): Identity {
  const handle = member.handle.toLowerCase()
  const own = CLIS[handle]
  const laneCli = member.agent?.lanes[0]?.split("/")[0]?.toLowerCase() ?? ""
  const cli = own ?? CLIS[laneCli] ?? null
  const role = own ? null : (ROLES[handle] ?? "other")
  return { cli, role, slot: cli ? SLOT[cli] : hash(member.id) % HUES.length }
}

export function hueFor(member: AvatarMember | null | undefined): Hue {
  if (!member || member.kind !== "agent") return HUMAN
  return HUES[identityOf(member).slot] ?? HUMAN
}

export function initialOf(name: string): string {
  return name.trim().charAt(0).toUpperCase() || "?"
}

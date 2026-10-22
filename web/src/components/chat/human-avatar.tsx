import type { Member } from "../../types"
import { initialOf } from "../../lib/avatar"

const COLORS = [
  "bg-agent-1-soft text-agent-1-fg",
  "bg-agent-2-soft text-agent-2-fg",
  "bg-agent-3-soft text-agent-3-fg",
  "bg-agent-4-soft text-agent-4-fg",
  "bg-agent-5-soft text-agent-5-fg",
  "bg-agent-6-soft text-agent-6-fg",
] as const

export function HumanAvatar({ member, size = 28, className = "" }: { member: Member | undefined; size?: number; className?: string }) {
  let hash = 0
  for (const char of member?.id ?? "") hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return <span
    data-testid="avatar"
    aria-hidden="true"
    style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
    className={`inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold leading-none ${COLORS[hash % COLORS.length]} ${className}`}
  >{initialOf(member?.display_name ?? "Member")}</span>
}

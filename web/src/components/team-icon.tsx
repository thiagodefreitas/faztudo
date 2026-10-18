import { cx } from "../lib/cx"
import type { Channel, Member } from "../types"
import { AgentAvatar, type AvatarSize } from "./agent-avatar"

export const TEAM_FACES = 3

// Agents first, then people, at most three faces. The rest become "+N".
export function teamFaces(channel: Channel, members: Member[], excludeId?: string): { shown: Member[]; extra: number } {
  const all = channel.member_ids
    .map((id) => members.find((member) => member.id === id))
    .filter((member): member is Member => Boolean(member) && member?.id !== excludeId)
    .sort((a, b) => Number(b.kind === "agent") - Number(a.kind === "agent"))
  return { shown: all.slice(0, TEAM_FACES), extra: Math.max(0, all.length - TEAM_FACES) }
}

// Face positions inside the square for two and three faces, as fractions of
// its size: two sit on a diagonal, three in a triangle.
const CLUSTER: Array<Array<{ left: string; top: string; width: string; height: string }>> = [
  [
    { left: "0", top: "0", width: "60%", height: "60%" },
    { left: "40%", top: "40%", width: "60%", height: "60%" },
  ],
  [
    { left: "0", top: "0", width: "55%", height: "55%" },
    { left: "45%", top: "8%", width: "55%", height: "55%" },
    { left: "20%", top: "45%", width: "55%", height: "55%" },
  ],
]

export function TeamIcon({
  channel,
  members,
  excludeId,
  size = 28,
  layout = "row",
  className,
}: {
  channel: Channel
  members: Member[]
  excludeId?: string
  size?: AvatarSize
  // "row" overlaps faces left to right (headers); "cluster" packs them into
  // a square of `size` (list rows, where the icon sits in an avatar's slot).
  layout?: "row" | "cluster"
  className?: string
}) {
  const { shown, extra } = teamFaces(channel, members, excludeId)
  if (layout === "cluster" && shown.length > 1) {
    return (
      <span
        data-testid="team-icon"
        aria-hidden="true"
        style={{ width: size, height: size }}
        className={cx("relative inline-block shrink-0", className)}
      >
        {shown.map((member, index) => (
          <span key={member.id} style={{ zIndex: TEAM_FACES - index, ...CLUSTER[shown.length - 2]![index] }} className="absolute inline-flex rounded-md ring-2 ring-surface">
            <AgentAvatar member={member} size={20} decorative className="h-full w-full" />
          </span>
        ))}
        {extra > 0 && (
          <span className="absolute -bottom-1 -right-1 z-10 rounded-full bg-line px-1 text-[10px] font-medium leading-4 text-muted ring-2 ring-surface">
            +{extra}
          </span>
        )}
      </span>
    )
  }
  if (shown.length === 0) {
    return (
      <span
        aria-hidden="true"
        style={{ width: size, height: size }}
        className={cx("inline-flex shrink-0 items-center justify-center rounded-lg bg-accent-soft font-semibold text-accent", className)}
      >
        #
      </span>
    )
  }
  return (
    <span data-testid="team-icon" aria-hidden="true" className={cx("inline-flex shrink-0 items-center", className)}>
      {shown.map((member, index) => (
        <span
          key={member.id}
          style={{ marginLeft: index === 0 ? 0 : -Math.round(size * 0.3), zIndex: TEAM_FACES - index }}
          className="inline-flex rounded-lg ring-2 ring-surface"
        >
          <AgentAvatar member={member} size={size} decorative />
        </span>
      ))}
      {extra > 0 && (
        <span
          style={{ marginLeft: -Math.round(size * 0.3), height: size, minWidth: size }}
          className="inline-flex items-center justify-center rounded-lg bg-line px-1 text-[11px] font-medium text-muted ring-2 ring-surface"
        >
          +{extra}
        </span>
      )}
    </span>
  )
}

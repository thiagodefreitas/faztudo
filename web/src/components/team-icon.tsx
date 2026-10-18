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

export function TeamIcon({
  channel,
  members,
  excludeId,
  size = 28,
  className,
}: {
  channel: Channel
  members: Member[]
  excludeId?: string
  size?: AvatarSize
  className?: string
}) {
  const { shown, extra } = teamFaces(channel, members, excludeId)
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

import type { Channel, ID, Member } from "../types"

export function isDirect(channel: Channel): boolean {
  return channel.kind === "direct" || channel.visibility === "direct"
}

// The other participant of a direct channel. A DM with yourself has none.
export function directPeer(channel: Channel, meId: ID | undefined, members: Member[]): Member | undefined {
  if (!isDirect(channel)) return undefined
  const otherId = channel.member_ids.find((id) => id !== meId)
  return members.find((member) => member.id === otherId)
}

export function findDirect(channels: Channel[], meId: ID, otherId: ID): Channel | undefined {
  return channels.find(
    (channel) =>
      isDirect(channel) &&
      channel.member_ids.length === 2 &&
      channel.member_ids.includes(meId) &&
      channel.member_ids.includes(otherId),
  )
}

function slug(handle: string): string {
  return handle.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "member"
}

// Channel names must match the channel name rule, so handles are slugged and
// ordered to keep the name stable whoever opens the DM first.
export function directName(a: Member, b: Member): string {
  return `dm-${[slug(a.handle), slug(b.handle)].sort().join("-")}`
}

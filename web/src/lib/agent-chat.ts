import type { Member, Message } from "../types"

export type Segment =
  | { kind: "message"; message: Message }
  | { kind: "agents"; messages: Message[] }

// A message is agent-to-agent when an agent wrote it and it mentions only
// other agents. A mention of any human, or no mention at all, keeps it visible.
export function isAgentChat(message: Message, byId: Map<string, Member>): boolean {
  if (byId.get(message.author_id)?.kind !== "agent") return false
  if (message.mentions.length === 0 || message.options?.length) return false
  return message.mentions.every((id) => id !== message.author_id && byId.get(id)?.kind === "agent")
}

// Consecutive agent-to-agent messages become one segment.
export function collapseAgentChat(messages: Message[], members: Member[]): Segment[] {
  const byId = new Map(members.map((member) => [member.id, member]))
  const out: Segment[] = []
  for (const message of messages) {
    if (!isAgentChat(message, byId)) {
      out.push({ kind: "message", message })
      continue
    }
    const last = out.at(-1)
    if (last?.kind === "agents") last.messages.push(message)
    else out.push({ kind: "agents", messages: [message] })
  }
  return out
}

// Who took part, in order of first appearance: authors and the agents they
// addressed.
export function participants(messages: Message[], members: Member[]): Member[] {
  const byId = new Map(members.map((member) => [member.id, member]))
  const seen = new Set<string>()
  const out: Member[] = []
  for (const message of messages) {
    for (const id of [message.author_id, ...message.mentions]) {
      const member = byId.get(id)
      if (member && !seen.has(id)) {
        seen.add(id)
        out.push(member)
      }
    }
  }
  return out
}

import type { Member, Message } from "../types"

export function choiceLetter(index: number): string {
  return String.fromCharCode(65 + index)
}

// The reply a person posts when they tap an option.
export function choiceBody(index: number, option: string): string {
  return `${choiceLetter(index)}: ${option}`
}

// Which option a person already answered, read from the thread. Only replies
// by humans count, so an agent cannot answer for them.
export function answeredChoice(options: string[], replies: Message[], members: Member[]): number | null {
  const humans = new Set(members.filter((member) => member.kind === "human").map((member) => member.id))
  for (const reply of replies) {
    if (!humans.has(reply.author_id)) continue
    const index = options.findIndex((option, i) => reply.body === choiceBody(i, option))
    if (index !== -1) return index
  }
  return null
}

// A key press picks an option: "b" or "B" is the second one.
export function choiceForKey(key: string, count: number): number | null {
  if (key.length !== 1) return null
  const index = key.toUpperCase().charCodeAt(0) - 65
  return index >= 0 && index < count ? index : null
}

import type { Approval, Member, Run } from "../types"

// Keys 1-9 pick an option by position. Enter picks the primary option,
// or the first option when none is marked primary. Resolved cards ignore keys.
export function approvalKeyAction(approval: Approval, key: string): string | null {
  if (approval.state !== "pending" || approval.options.length === 0) return null
  if (key === "Enter") {
    const primary = approval.options.find((option) => option.style === "primary") ?? approval.options[0]
    return primary?.key ?? null
  }
  if (/^[1-9]$/.test(key)) {
    return approval.options[Number(key) - 1]?.key ?? null
  }
  return null
}

export type ApprovalShortcut = { kind: "option"; option: string } | { kind: "edit" }

// Letters for the write approval: m merges, k keeps, d discards, e edits the
// commit message. Other approvals keep digits and Enter only.
const LETTER: Record<string, string[]> = { m: ["merge"], k: ["keep", "hold"], d: ["discard", "drop"] }

export function optionLetter(optionKey: string): string | null {
  for (const [letter, keys] of Object.entries(LETTER)) if (keys.includes(optionKey)) return letter
  return null
}

export function approvalShortcut(approval: Approval, key: string): ApprovalShortcut | null {
  if (approval.state !== "pending") return null
  const lower = key.toLowerCase()
  if (lower === "e") return approval.commit_message !== undefined ? { kind: "edit" } : null
  const keys = LETTER[lower]
  if (keys) {
    const option = approval.options.find((item) => keys.includes(item.key))
    return option ? { kind: "option", option: option.key } : null
  }
  const option = approvalKeyAction(approval, key)
  return option ? { kind: "option", option } : null
}

/** Danger options ask once more before they run. */
export function needsConfirm(approval: Approval, optionKey: string): boolean {
  return approval.options.find((option) => option.key === optionKey)?.style === "danger"
}

function files(count: number): string {
  return `${count} ${count === 1 ? "file" : "files"}`
}

/**
 * The one line a person reads first, "Merge Coder's change: 3 files, tests
 * passed". Approvals that are not a write run keep their own title.
 */
export function approvalSummary(approval: Approval, run: Run | undefined, agentName: string | undefined): string {
  if (approval.commit_message === undefined) return approval.title
  const who = agentName ?? "the agent"
  const parts: string[] = []
  if (run?.diff_stat) parts.push(files(run.diff_stat.files))
  if (run?.verification) parts.push(run.verification.ok ? "tests passed" : "tests failed")
  return `Merge ${who}'s change${parts.length > 0 ? `: ${parts.join(", ")}` : ""}`
}

/** The short commit id the server names in its merge note, if any. */
export function shortSha(note: string | undefined): string | undefined {
  return note ? /\b(?=[0-9a-f]*\d)[0-9a-f]{7,12}\b/.exec(note)?.[0] : undefined
}

/** What was decided, for the collapsed card: "Merged as abc1234". */
export function outcomeText(approval: Approval): string {
  const resolution = approval.resolution
  if (approval.state === "expired" || !resolution) return "Expired"
  const option = approval.options.find((item) => item.key === resolution.option)
  const sha = shortSha(resolution.note)
  switch (resolution.option) {
    case "merge":
      return sha ? `Merged as ${sha}` : "Merged"
    case "keep":
      return "Kept the branch"
    case "discard":
      return "Discarded"
    default:
      return `Answered with ${option?.label ?? resolution.option}`
  }
}

export function deciderName(approval: Approval, members: Member[]): string | undefined {
  const by = approval.resolution?.by
  return by ? members.find((member) => member.id === by)?.display_name : undefined
}

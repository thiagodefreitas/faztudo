import type { Approval } from "../types"

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

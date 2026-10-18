import type { Approval, Message } from "../../types"

export type ChatFilter = "all" | "mentions" | "runs" | "decisions" | "files"

export const FILTERS: { id: ChatFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "mentions", label: "Mentions of me" },
  { id: "runs", label: "Runs" },
  { id: "decisions", label: "Decisions" },
  { id: "files", label: "Files" },
]

export interface FilterContext {
  meId: string | undefined
  /** Runs that have an approval, so their message counts as a decision. */
  approvalRunIds: Set<string>
}

export function filterContext(meId: string | undefined, approvals: Approval[]): FilterContext {
  return { meId, approvalRunIds: new Set(approvals.flatMap((approval) => (approval.run_id ? [approval.run_id] : []))) }
}

export function matchesFilter(message: Message, filter: ChatFilter, context: FilterContext): boolean {
  switch (filter) {
    case "all":
      return true
    case "mentions":
      return !!context.meId && message.author_id !== context.meId && message.mentions.includes(context.meId)
    case "runs":
      return !!message.run_id
    case "decisions":
      return (message.options?.length ?? 0) > 0 || (!!message.run_id && context.approvalRunIds.has(message.run_id))
    case "files":
      return (message.attachments?.length ?? 0) > 0
  }
}

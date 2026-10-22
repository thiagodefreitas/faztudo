import { describe, expect, it } from "vitest"
import type { Approval, Run } from "../types"
import { approvalKeyAction, approvalShortcut, approvalSummary, needsConfirm, outcomeText } from "./approval"

const approval: Approval = {
  id: "01DRZ3NDEKTSV4RRFFQ69G5DD9",
  channel_id: "01BRZ3NDEKTSV4RRFFQ69G5BB1",
  requested_by: "01ARZ3NDEKTSV4RRFFQ69G5AA2",
  title: "Push branch",
  detail: "push",
  state: "pending",
  options: [
    { key: "push", label: "Push", style: "primary" },
    { key: "hold", label: "Hold" },
    { key: "drop", label: "Drop", style: "danger" },
  ],
}

describe("approvalKeyAction", () => {
  it("maps 1-9 and Enter to options", () => {
    expect(approvalKeyAction(approval, "1")).toBe("push")
    expect(approvalKeyAction(approval, "2")).toBe("hold")
    expect(approvalKeyAction(approval, "3")).toBe("drop")
    expect(approvalKeyAction(approval, "9")).toBeNull()
    expect(approvalKeyAction(approval, "Enter")).toBe("push")
    expect(approvalKeyAction({ ...approval, state: "resolved" }, "1")).toBeNull()
  })

  it("uses the first option when none is primary", () => {
    const plain: Approval = {
      ...approval,
      options: [
        { key: "hold", label: "Hold" },
        { key: "drop", label: "Drop" },
      ],
    }
    expect(approvalKeyAction(plain, "Enter")).toBe("hold")
  })
})

const write: Approval = {
  ...approval,
  id: "01DRZ3NDEKTSV4RRFFQ69G5DE0",
  run_id: "01ERZ3NDEKTSV4RRFFQ69G5EE1",
  title: "Choose what to do with branch fz/run-demo",
  commit_message: "Add the thing",
  options: [
    { key: "merge", label: "Merge", style: "primary" },
    { key: "keep", label: "Keep" },
    { key: "discard", label: "Discard", style: "danger" },
  ],
}

describe("approvalShortcut", () => {
  it("maps m, k, d and e on a write approval, in either case", () => {
    expect(approvalShortcut(write, "m")).toEqual({ kind: "option", option: "merge" })
    expect(approvalShortcut(write, "K")).toEqual({ kind: "option", option: "keep" })
    expect(approvalShortcut(write, "d")).toEqual({ kind: "option", option: "discard" })
    expect(approvalShortcut(write, "e")).toEqual({ kind: "edit" })
  })

  it("keeps digits and Enter, and ignores letters it has no option for", () => {
    expect(approvalShortcut(write, "2")).toEqual({ kind: "option", option: "keep" })
    expect(approvalShortcut(write, "Enter")).toEqual({ kind: "option", option: "merge" })
    expect(approvalShortcut(approval, "m")).toBeNull()
    expect(approvalShortcut(approval, "e")).toBeNull()
  })

  it("ignores everything once resolved", () => {
    expect(approvalShortcut({ ...write, state: "resolved" }, "m")).toBeNull()
  })

  it("asks to confirm danger options only", () => {
    expect(needsConfirm(write, "discard")).toBe(true)
    expect(needsConfirm(write, "merge")).toBe(false)
  })
})

describe("approvalSummary", () => {
  const run = { diff_stat: { files: 3, insertions: 9, deletions: 1 }, verification: { ok: true, detail: "ok" } } as Run
  it("leads with the merge and what the run did", () => {
    expect(approvalSummary(write, run, "Coder")).toBe("Merge Coder's change: 3 files, tests passed")
    expect(approvalSummary(write, { ...run, verification: { ok: false, detail: "x" } } as Run, "Coder")).toBe(
      "Merge Coder's change: 3 files, tests failed",
    )
    expect(approvalSummary(write, undefined, undefined)).toBe("Merge the agent's change")
  })
  it("keeps the title of other approvals", () => {
    expect(approvalSummary(approval, undefined, "Coder")).toBe("Push branch")
  })
})

describe("outcomeText", () => {
  const resolved = (option: string, note?: string): Approval => ({
    ...write,
    state: "resolved",
    resolution: { option, by: "m1", at: "2026-10-18T12:00:00.000Z", ...(note ? { note } : {}) },
  })
  it("names the short sha of a merge", () => {
    expect(outcomeText(resolved("merge", "Fast-forwarded fz/run-demo into the current branch as 1a2b3c4."))).toBe("Merged as 1a2b3c4")
    expect(outcomeText(resolved("merge", "Merged fz/x on top of changes."))).toBe("Merged")
    expect(outcomeText(resolved("merge", "Merged by rule abcdef12. Fast-forwarded."))).toBe("Merged by rule")
  })
  it("words keep, discard and other answers", () => {
    expect(outcomeText(resolved("keep"))).toBe("Kept the branch")
    expect(outcomeText(resolved("discard"))).toBe("Discarded")
    expect(outcomeText({ ...resolved("push"), options: approval.options })).toBe("Answered with Push")
    expect(outcomeText({ ...write, state: "expired" })).toBe("Expired")
  })
})

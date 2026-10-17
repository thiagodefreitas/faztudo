import { describe, expect, it } from "vitest"
import type { Approval } from "../types"
import { approvalKeyAction } from "./approval"

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

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import type { Approval } from "../types"
import { ApprovalCard } from "./approval-card"

const approval: Approval = {
  id: "01DRZ3NDEKTSV4RRFFQ69G5DD8",
  channel_id: "01BRZ3NDEKTSV4RRFFQ69G5BB1",
  requested_by: "01ARZ3NDEKTSV4RRFFQ69G5AA2",
  title: "Push branch fz/run-demo to origin",
  detail: "Push the branch.\n\n```\ngit push origin HEAD\n```",
  state: "pending",
  options: [
    { key: "push", label: "Push", style: "primary" },
    { key: "hold", label: "Hold" },
    { key: "drop", label: "Drop", style: "danger" },
  ],
}

describe("ApprovalCard", () => {
  it("answers from the keyboard when the card is focused", async () => {
    const user = userEvent.setup()
    const onResolve = vi.fn()
    render(<ApprovalCard approval={approval} onResolve={onResolve} />)
    const card = screen.getByRole("article", { name: /Push branch/ })
    card.focus()
    await user.keyboard("2")
    expect(onResolve).toHaveBeenCalledWith("hold")
    await user.keyboard("{Enter}")
    expect(onResolve).toHaveBeenCalledWith("push")
  })

  it("sends the edited commit message with Merge only", async () => {
    const user = userEvent.setup()
    const onResolve = vi.fn()
    const write: Approval = {
      ...approval,
      title: "Choose what to do with branch fz/run-demo",
      commit_message: "Add the thing\n\nfaztudo run run-demo",
      options: [
        { key: "merge", label: "Merge", style: "primary" },
        { key: "keep", label: "Keep" },
      ],
    }
    render(<ApprovalCard approval={write} onResolve={onResolve} />)
    const box = screen.getByRole("textbox", { name: "Commit message" })
    expect(box).toHaveValue("Add the thing\n\nfaztudo run run-demo")
    await user.clear(box)
    await user.type(box, "Fix the thing")
    await user.click(screen.getByRole("button", { name: /Merge/ }))
    expect(onResolve).toHaveBeenLastCalledWith("merge", "Fix the thing")
    await user.click(screen.getByRole("button", { name: /Keep/ }))
    expect(onResolve).toHaveBeenLastCalledWith("keep")
  })

  it("shows no message box without a proposal", () => {
    render(<ApprovalCard approval={approval} onResolve={() => undefined} />)
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
  })

  it("shows the chosen option after it is resolved", () => {
    render(
      <ApprovalCard
        approval={{
          ...approval,
          state: "resolved",
          resolution: { option: "push", by: "01ARZ3NDEKTSV4RRFFQ69G5AA1", at: "2026-10-18T12:00:00.000Z" },
        }}
        onResolve={() => undefined}
      />,
    )
    expect(screen.getByText("Answered with Push")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Push/ })).not.toBeInTheDocument()
  })
})

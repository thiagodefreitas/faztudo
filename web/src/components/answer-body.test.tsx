import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { AnswerBody } from "./answer-body"

const long = [
  "Summary line that stays.",
  ...Array.from({ length: 20 }, (_, i) => `detail ${i + 1}`),
  "",
  "## Risks",
  "last words",
].join("\n")

describe("AnswerBody", () => {
  it("folds a long agent answer and keeps its later headings visible", () => {
    render(<AnswerBody text={long} channels={undefined} fold />)
    expect(screen.getByText(/Summary line that stays/)).toBeInTheDocument()
    expect(screen.queryByText(/last words/)).not.toBeInTheDocument()
    expect(screen.getByText("Further down:")).toBeInTheDocument()
    expect(screen.getByText(/Risks/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Show all/ })).toHaveAttribute("aria-expanded", "false")
  })

  it("shows everything after Show all, and folds again on Show less", () => {
    render(<AnswerBody text={long} channels={undefined} fold />)
    fireEvent.click(screen.getByRole("button", { name: /Show all/ }))
    expect(screen.getByText(/last words/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Show less" }))
    expect(screen.queryByText(/last words/)).not.toBeInTheDocument()
  })

  it("leaves short answers and human messages whole", () => {
    const { rerender } = render(<AnswerBody text="Short answer." channels={undefined} fold />)
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
    rerender(<AnswerBody text={long} channels={undefined} fold={false} />)
    expect(screen.getByText(/last words/)).toBeInTheDocument()
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
  })
})

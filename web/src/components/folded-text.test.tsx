import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"
import { FoldedText } from "./folded-text"

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n")

describe("FoldedText", () => {
  it("shows short text without a toggle", () => {
    render(<FoldedText text={lines(6)} />)
    expect(screen.getByText(/line 6/)).toBeTruthy()
    expect(screen.queryByRole("button")).toBeNull()
  })

  it("folds long text to six lines and opens on demand", async () => {
    const user = userEvent.setup()
    render(<FoldedText text={lines(20)} />)
    expect(screen.getByText(/line 6/)).toBeTruthy()
    expect(screen.queryByText(/line 7/)).toBeNull()
    const toggle = screen.getByRole("button", { name: "Show all (20 lines)" })
    expect(toggle.getAttribute("aria-expanded")).toBe("false")
    await user.click(toggle)
    expect(screen.getByText(/line 20/)).toBeTruthy()
    await user.click(screen.getByRole("button", { name: "Show less" }))
    expect(screen.queryByText(/line 7/)).toBeNull()
  })
})

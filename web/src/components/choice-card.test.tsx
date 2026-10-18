import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { ChoiceCard } from "./choice-card"

describe("ChoiceCard", () => {
  it("shows lettered options and answers on tap", async () => {
    const onChoose = vi.fn()
    render(<ChoiceCard options={["fast", "safe"]} answered={null} onChoose={onChoose} />)
    expect(screen.getByRole("button", { name: /A\s*fast/ })).toBeEnabled()
    await userEvent.click(screen.getByRole("button", { name: /B\s*safe/ }))
    expect(onChoose).toHaveBeenCalledWith(1)
  })

  it("answers with the letter key while focused", async () => {
    const onChoose = vi.fn()
    render(<ChoiceCard options={["fast", "safe", "later"]} answered={null} onChoose={onChoose} />)
    screen.getByRole("group", { name: "Choices" }).focus()
    await userEvent.keyboard("c")
    expect(onChoose).toHaveBeenCalledWith(2)
    await userEvent.keyboard("z")
    expect(onChoose).toHaveBeenCalledTimes(1)
  })

  it("marks the chosen option and disables the rest", async () => {
    const onChoose = vi.fn()
    render(<ChoiceCard options={["fast", "safe"]} answered={1} onChoose={onChoose} />)
    expect(screen.getByRole("button", { name: /B\s*safe/ })).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByRole("button", { name: /A\s*fast/ })).toBeDisabled()
    expect(screen.getByRole("button", { name: /B\s*safe/ })).toBeDisabled()
    screen.getByRole("group", { name: "Choices" }).focus()
    await userEvent.keyboard("a")
    expect(onChoose).not.toHaveBeenCalled()
  })
})

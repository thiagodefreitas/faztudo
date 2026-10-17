import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import type { Member } from "../types"
import { Composer } from "./composer"

const members: Member[] = [
  {
    id: "01ARZ3NDEKTSV4RRFFQ69G5AA2",
    kind: "agent",
    handle: "coder",
    display_name: "Coder",
    presence: "online",
    agent: { lanes: ["codex/default"] },
  },
  {
    id: "01ARZ3NDEKTSV4RRFFQ69G5AA1",
    kind: "human",
    handle: "ada",
    display_name: "Ada",
    presence: "online",
  },
]

describe("Composer", () => {
  it("completes a mention on Enter and sends on the next Enter", async () => {
    const user = userEvent.setup()
    const onSend = vi.fn()
    render(<Composer members={members} channelName="faztudo-dev" onSend={onSend} />)
    const box = screen.getByRole("textbox", { name: "Message" })
    await user.type(box, "@co")
    expect(screen.getByRole("option", { name: /Coder/ })).toBeInTheDocument()
    await user.keyboard("{Enter}")
    expect(onSend).not.toHaveBeenCalled()
    expect(box).toHaveValue("@coder ")
    await user.type(box, "hello")
    await user.keyboard("{Enter}")
    expect(onSend).toHaveBeenCalledWith("@coder hello")
  })

  it("inserts a newline on Shift+Enter", async () => {
    const user = userEvent.setup()
    const onSend = vi.fn()
    render(<Composer members={members} channelName="faztudo-dev" onSend={onSend} />)
    const box = screen.getByRole("textbox", { name: "Message" })
    await user.type(box, "line")
    await user.keyboard("{Shift>}{Enter}{/Shift}")
    expect(onSend).not.toHaveBeenCalled()
    expect(box).toHaveValue("line\n")
  })
})

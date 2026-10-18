import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { ApiError, api } from "../api/client"
import type { Attachment, Member } from "../types"
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

  it("has no attach button unless asked", () => {
    render(<Composer members={members} channelName="faztudo-dev" onSend={vi.fn()} />)
    expect(screen.queryByRole("button", { name: "Attach a file" })).not.toBeInTheDocument()
  })

  it("uploads a chosen file and sends it with the text", async () => {
    const user = userEvent.setup()
    const onSend = vi.fn()
    const attachment: Attachment = { id: "a".repeat(64), name: "notes.txt", content_type: "application/octet-stream", size: 11 }
    const upload = vi.spyOn(api, "uploadFile").mockResolvedValue(attachment)
    render(<Composer members={members} channelName="faztudo-dev" attach onSend={onSend} />)
    const file = new File(["hello notes"], "notes.txt", { type: "text/plain" })
    await user.upload(screen.getByTestId("file-input"), file)
    expect(upload).toHaveBeenCalledWith(file)
    expect(await screen.findByText("11 B")).toBeInTheDocument()
    await user.type(screen.getByRole("textbox", { name: "Message" }), "see attached{Enter}")
    expect(onSend).toHaveBeenCalledWith("see attached", [attachment])
    expect(screen.queryByRole("list", { name: "Files to send" })).not.toBeInTheDocument()
  })

  it("sends a file with no text, but not while it is still uploading", async () => {
    const user = userEvent.setup()
    const onSend = vi.fn()
    const attachment: Attachment = { id: "b".repeat(64), name: "pic.png", content_type: "image/png", size: 5 }
    let finish: (value: Attachment) => void = () => {}
    vi.spyOn(api, "uploadFile").mockReturnValue(new Promise((resolve) => (finish = resolve)))
    render(<Composer members={members} channelName="faztudo-dev" attach onSend={onSend} />)
    await user.upload(screen.getByTestId("file-input"), new File(["12345"], "pic.png", { type: "image/png" }))
    expect(await screen.findByText("Uploading")).toBeInTheDocument()
    await user.type(screen.getByRole("textbox", { name: "Message" }), "{Enter}")
    expect(onSend).not.toHaveBeenCalled()
    finish(attachment)
    expect(await screen.findByText("5 B")).toBeInTheDocument()
    await user.type(screen.getByRole("textbox", { name: "Message" }), "{Enter}")
    expect(onSend).toHaveBeenCalledWith("", [attachment])
  })

  it("shows why an upload failed and lets the person remove it", async () => {
    const user = userEvent.setup()
    vi.spyOn(api, "uploadFile").mockRejectedValue(new ApiError(413, "too_large", "file is larger than the upload limit"))
    render(<Composer members={members} channelName="faztudo-dev" attach onSend={vi.fn()} />)
    await user.upload(screen.getByTestId("file-input"), new File(["x"], "big.bin"))
    expect(await screen.findByText("file is larger than the upload limit")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Remove big.bin" }))
    expect(screen.queryByText("big.bin")).not.toBeInTheDocument()
  })
})

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiError, api } from "../api/client"
import type { Attachment, Member } from "../types"
import { Composer, readDraft, writeDraft } from "./composer"

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

describe("Composer tasks", () => {
  it("opens the task builder from the Task button", async () => {
    const user = userEvent.setup()
    const onTask = vi.fn()
    render(<Composer members={members} channelName="dev" onSend={vi.fn()} onTask={onTask} />)
    await user.click(screen.getByRole("button", { name: "New task" }))
    expect(onTask).toHaveBeenCalledWith("")
  })

  it("opens the builder for /task and sends nothing", async () => {
    const user = userEvent.setup()
    const onSend = vi.fn()
    const onTask = vi.fn()
    render(<Composer members={members} channelName="dev" onSend={onSend} onTask={onTask} />)
    const box = screen.getByRole("textbox", { name: "Message" })
    await user.type(box, "/task Fix the login{Enter}")
    expect(onTask).toHaveBeenCalledWith("Fix the login")
    expect(onSend).not.toHaveBeenCalled()
    expect(box).toHaveValue("")
  })

  it("shows task mode and changes the hint while typing /task", async () => {
    render(<Composer members={members} channelName="dev" onSend={vi.fn()} onTask={vi.fn()} />)
    expect(screen.getByText("Type @ to mention someone or /task to create a task")).toBeInTheDocument()
    await userEvent.type(screen.getByRole("textbox", { name: "Message" }), "/task Review the patch")
    expect(screen.getByText("New task")).toBeInTheDocument()
    expect(screen.getByText("Enter to open the task builder")).toBeInTheDocument()
  })

  it("sends /task as plain text when there is no builder", async () => {
    const user = userEvent.setup()
    const onSend = vi.fn()
    render(<Composer members={members} channelName="dev" onSend={onSend} />)
    expect(screen.queryByRole("button", { name: "New task" })).not.toBeInTheDocument()
    await user.type(screen.getByRole("textbox", { name: "Message" }), "/task x{Enter}")
    expect(onSend).toHaveBeenCalledWith("/task x")
  })
})

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

  it("matches a mention by display name and picks it with Tab", async () => {
    const user = userEvent.setup()
    const onSend = vi.fn()
    render(<Composer members={members} channelName="faztudo-dev" onSend={onSend} />)
    const box = screen.getByRole("textbox", { name: "Message" })
    await user.type(box, "hi @Ad")
    expect(screen.getByRole("option", { name: /Ada/ })).toBeInTheDocument()
    await user.keyboard("{Tab}")
    expect(box).toHaveValue("hi @ada ")
    expect(box).toHaveFocus()
    expect(onSend).not.toHaveBeenCalled()
  })

  it("never sends while an IME is composing", async () => {
    const user = userEvent.setup()
    const onSend = vi.fn()
    render(<Composer members={members} channelName="faztudo-dev" onSend={onSend} />)
    const box = screen.getByRole("textbox", { name: "Message" })
    await user.type(box, "kanji")
    fireEvent.keyDown(box, { key: "Enter", isComposing: true })
    fireEvent.keyDown(box, { key: "Enter", keyCode: 229 })
    expect(onSend).not.toHaveBeenCalled()
    expect(box).toHaveValue("kanji")
    fireEvent.keyDown(box, { key: "Enter" })
    expect(onSend).toHaveBeenCalledWith("kanji")
  })

  it("disables Send until there is something to send", async () => {
    const user = userEvent.setup()
    const onSend = vi.fn()
    render(<Composer members={members} channelName="faztudo-dev" onSend={onSend} />)
    const send = screen.getByRole("button", { name: "Send" })
    expect(send).toBeDisabled()
    await user.click(send)
    expect(onSend).not.toHaveBeenCalled()
    await user.type(screen.getByRole("textbox", { name: "Message" }), "ready")
    expect(send).toBeEnabled()
    await user.click(send)
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(send).toBeDisabled()
  })

  it("appends a suggested mention without replacing an unsent draft", async () => {
    const onSend = vi.fn()
    const view = render(<Composer members={members} channelName="dev" onSend={onSend} />)
    const box = screen.getByRole("textbox", { name: "Message" })
    await userEvent.type(box, "Keep this draft")
    view.rerender(<Composer members={members} channelName="dev" onSend={onSend} suggestion={{ id: 1, text: "@coder " }} />)
    expect(box).toHaveValue("Keep this draft @coder ")
    expect(box).toHaveFocus()
  })
})

describe("Composer drafts", () => {
  afterEach(() => {
    localStorage.clear()
  })

  it("restores the draft for its key and writes what is typed", async () => {
    const user = userEvent.setup()
    writeDraft("c1", "half a thought")
    render(<Composer members={members} channelName="dev" draftKey="c1" onSend={vi.fn()} />)
    const box = screen.getByRole("textbox", { name: "Message" })
    expect(box).toHaveValue("half a thought")
    await user.type(box, " more")
    await waitFor(() => expect(readDraft("c1")).toBe("half a thought more"))
  })

  it("keeps drafts apart per key and clears the draft on send", async () => {
    const user = userEvent.setup()
    const onSend = vi.fn()
    writeDraft("c1", "for dev")
    writeDraft("c2", "for ops")
    const { unmount } = render(<Composer key="c1" members={members} channelName="dev" draftKey="c1" onSend={onSend} />)
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("for dev")
    unmount()
    render(<Composer key="c2" members={members} channelName="ops" draftKey="c2" onSend={onSend} />)
    const box = screen.getByRole("textbox", { name: "Message" })
    expect(box).toHaveValue("for ops")
    await user.type(box, "{Enter}")
    expect(onSend).toHaveBeenCalledWith("for ops")
    expect(readDraft("c2")).toBe("")
    expect(readDraft("c1")).toBe("for dev")
  })

  it("flushes the draft when the composer unmounts before the timer", async () => {
    const user = userEvent.setup()
    const { unmount } = render(<Composer members={members} channelName="dev" draftKey="c3" onSend={vi.fn()} />)
    await user.type(screen.getByRole("textbox", { name: "Message" }), "quick")
    unmount()
    expect(readDraft("c3")).toBe("quick")
  })

  it("survives a blocked store", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    expect(readDraft("c1")).toBe("")
    expect(() => writeDraft("c1", "x")).not.toThrow()
    render(<Composer members={members} channelName="dev" draftKey="c1" onSend={vi.fn()} />)
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("")
    getItem.mockRestore()
    setItem.mockRestore()
  })
})

describe("Composer focus", () => {
  const original = window.matchMedia

  function pointer(matches: boolean) {
    window.matchMedia = (query: string) => ({ ...original(query), matches: query.includes("pointer: fine") && matches })
  }

  afterEach(() => {
    window.matchMedia = original
  })

  it("takes focus on mount with a mouse and puts the cursor at the end of the draft", () => {
    pointer(true)
    writeDraft("c1", "draft")
    render(<Composer members={members} channelName="dev" draftKey="c1" autoFocus onSend={vi.fn()} />)
    const box = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement
    expect(box).toHaveFocus()
    expect(box.selectionStart).toBe(5)
    localStorage.clear()
  })

  it("leaves the keyboard down on a phone", () => {
    pointer(false)
    render(<Composer members={members} channelName="dev" autoFocus onSend={vi.fn()} />)
    expect(screen.getByRole("textbox", { name: "Message" })).not.toHaveFocus()
  })

  it("does not take focus unless asked", () => {
    pointer(true)
    render(<Composer members={members} channelName="dev" onSend={vi.fn()} />)
    expect(screen.getByRole("textbox", { name: "Message" })).not.toHaveFocus()
  })
})

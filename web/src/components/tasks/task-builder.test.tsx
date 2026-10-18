import { screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { api } from "../../api/client"
import { channel, renderWithApp, task } from "./test-utils"
import { TaskBuilder } from "./task-builder"

afterEach(() => vi.restoreAllMocks())

async function open(props: Partial<Parameters<typeof TaskBuilder>[0]> = {}) {
  const onOpenChange = vi.fn()
  const view = await renderWithApp(<TaskBuilder open onOpenChange={onOpenChange} channels={[channel]} channelId="c1" {...props} />)
  return { onOpenChange, ...view }
}

describe("TaskBuilder", () => {
  it("lists the agents as choices with their names and picks the first", async () => {
    await open()
    const group = screen.getByRole("radiogroup", { name: "Assignee" })
    expect(within(group).getAllByRole("radio").map((radio) => radio.getAttribute("value"))).toEqual(["coder", "reviewer"])
    expect(within(group).getByRole("radio", { name: /Coder/ })).toBeChecked()
  })

  it("fills the form from a template", async () => {
    await open()
    await userEvent.click(screen.getByRole("button", { name: "Implement" }))
    expect(screen.getByLabelText("Title")).toHaveValue("Implement ")
    expect(screen.getByRole("radio", { name: "Write" })).toBeChecked()
    expect(screen.getByLabelText("Acceptance criteria")).toHaveValue("The change works as described\nExisting tests still pass")
    await userEvent.click(screen.getByRole("button", { name: "Review" }))
    expect(screen.getByRole("radio", { name: "Read" })).toBeChecked()
  })

  it("offers only the lanes of the chosen agent", async () => {
    await open()
    const lanes = () => within(screen.getByLabelText("Lane")).getAllByRole("option").map((option) => option.getAttribute("value"))
    expect(lanes()).toEqual(["", "codex/default", "claude/sonnet"])
    await userEvent.click(screen.getByRole("radio", { name: /Reviewer/ }))
    expect(lanes()).toEqual(["", "claude/sonnet"])
  })

  it("asks for a title before it sends anything", async () => {
    const create = vi.spyOn(api, "createTask")
    await open()
    await userEvent.click(screen.getByRole("button", { name: "Add to Todo" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("title")
    expect(create).not.toHaveBeenCalled()
  })

  it("adds a task to Todo with its lists split into lines", async () => {
    const create = vi.spyOn(api, "createTask").mockResolvedValue(task("n", "todo"))
    const { onOpenChange } = await open()
    await userEvent.type(screen.getByLabelText("Title"), "Fix login")
    await userEvent.type(screen.getByLabelText("Directive"), "It drops the password.")
    await userEvent.type(screen.getByLabelText("Scope"), "web/src/login.tsx{Enter}internal/api")
    await userEvent.type(screen.getByLabelText("Checks"), "npm test")
    await userEvent.click(screen.getByRole("radio", { name: "Write" }))
    await userEvent.selectOptions(screen.getByLabelText("Lane"), "claude/sonnet")
    await userEvent.click(screen.getByRole("button", { name: "Add to Todo" }))
    expect(create).toHaveBeenCalledWith({
      channel_id: "c1",
      title: "Fix login",
      body: "It drops the password.",
      assignee: "coder",
      lane: "claude/sonnet",
      mode: "write",
      scope: ["web/src/login.tsx", "internal/api"],
      checks: ["npm test"],
      acceptance: [],
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("starts the task at once from Start now", async () => {
    const create = vi.spyOn(api, "createTask").mockResolvedValue(task("n", "running"))
    await open({ initialTitle: "Look at it" })
    await userEvent.click(screen.getByRole("button", { name: "Start now" }))
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ title: "Look at it", start: true }))
  })

  it("keeps the dialog open and shows the server's reason when it refuses", async () => {
    vi.spyOn(api, "createTask").mockRejectedValue(new Error("Write tasks need a channel repo_path."))
    const { onOpenChange } = await open({ initialTitle: "x" })
    await userEvent.click(screen.getByRole("button", { name: "Start now" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Write tasks need a channel repo_path.")
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })

  it("lets me pick the channel when none is given", async () => {
    const create = vi.spyOn(api, "createTask").mockResolvedValue(task("n", "todo"))
    await open({ channelId: undefined, initialTitle: "Anywhere" })
    await userEvent.selectOptions(screen.getByLabelText("Channel"), "c1")
    await userEvent.click(screen.getByRole("button", { name: "Add to Todo" }))
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ channel_id: "c1" }))
  })
})

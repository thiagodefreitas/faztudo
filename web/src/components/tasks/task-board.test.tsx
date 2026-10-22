import { fireEvent, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { api } from "../../api/client"
import { channel, coder, reviewer, renderWithApp, run, task } from "./test-utils"
import { TaskBoard } from "./task-board"

afterEach(() => vi.restoreAllMocks())

const tasks = [
  task("a", "todo", { order: 1, title: "First todo" }),
  task("b", "todo", { order: 2, title: "Second todo" }),
  task("c", "running", { title: "Running one", assignee: "reviewer" }),
  task("d", "review", { title: "Waiting one" }),
  task("e", "failed", { title: "Broken one" }),
  task("f", "done", { title: "Finished one" }),
]

async function renderBoard(list = tasks, seed = {}) {
  return renderWithApp(<TaskBoard tasks={list} members={[coder, reviewer]} channels={[channel]} />, { tasks: list, ...seed })
}

describe("TaskBoard", () => {
  it("has the four columns, each with its tasks and a count", async () => {
    await renderBoard()
    const todo = screen.getByRole("region", { name: "Todo" })
    expect(within(todo).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      expect.stringContaining("First todo"),
      expect.stringContaining("Second todo"),
    ])
    expect(screen.getByRole("region", { name: "Running" })).toHaveTextContent("Running one")
    const review = screen.getByRole("region", { name: "Review" })
    expect(review).toHaveTextContent("Waiting one")
    expect(review).toHaveTextContent("Broken one")
    expect(review).toHaveTextContent("Failed")
    expect(screen.getByRole("region", { name: "Done" })).toHaveTextContent("Finished one")
  })

  it("shows an empty column in plain words", async () => {
    await renderBoard([task("a", "todo")])
    expect(within(screen.getByRole("region", { name: "Running" })).getByText("Nothing here.")).toBeInTheDocument()
  })

  it("offers a quick Add in Todo only when the page can add", async () => {
    const onAdd = vi.fn()
    await renderWithApp(<TaskBoard tasks={tasks} members={[coder, reviewer]} channels={[channel]} onAdd={onAdd} />, { tasks })
    const todo = screen.getByRole("region", { name: "Todo" })
    await userEvent.click(within(todo).getByRole("button", { name: "Add" }))
    expect(onAdd).toHaveBeenCalledTimes(1)
    expect(within(screen.getByRole("region", { name: "Running" })).queryByRole("button", { name: "Add" })).not.toBeInTheDocument()
  })

  it("shows the assignee, the status pill and the age on a card", async () => {
    await renderBoard()
    const card = within(screen.getByRole("region", { name: "Running" })).getByRole("button", { name: /^Running one/ })
    expect(card).toHaveTextContent("Reviewer")
    expect(card).toHaveTextContent("Running")
    expect(card.querySelector("time")).not.toBeNull()
  })

  it("moves a Todo task down with the keyboard buttons", async () => {
    const patch = vi.spyOn(api, "patchTask").mockResolvedValue(task("a", "todo"))
    await renderBoard()
    await userEvent.click(screen.getByRole("button", { name: "Move First todo down" }))
    expect(patch).toHaveBeenCalledWith("a", { order: 3 })
  })

  it("offers no move buttons at the ends of the Todo column", async () => {
    await renderBoard()
    expect(screen.queryByRole("button", { name: "Move First todo up" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Move Second todo down" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Move Running one up" })).not.toBeInTheDocument()
  })

  it("reorders Todo by dragging one card onto another", async () => {
    const patch = vi.spyOn(api, "patchTask").mockResolvedValue(task("b", "todo"))
    await renderBoard()
    const cards = within(screen.getByRole("region", { name: "Todo" })).getAllByRole("listitem")
    const data = { setData: vi.fn(), getData: () => "b", effectAllowed: "" }
    fireEvent.dragStart(cards[1]!, { dataTransfer: data })
    fireEvent.dragOver(cards[0]!, { dataTransfer: data })
    fireEvent.drop(cards[0]!, { dataTransfer: data })
    await waitFor(() => expect(patch).toHaveBeenCalledWith("b", { order: 0 }))
  })

  it("opens a task with its directive, runs and links", async () => {
    const full = task("g", "review", {
      title: "Fix login",
      body: "It drops the password.",
      scope: ["web/src/login.tsx"],
      checks: ["npm test"],
      acceptance: ["Login works"],
      run_ids: ["r1"],
      approval_id: "ap1",
      mode: "write",
      lane: "codex/default",
    })
    await renderBoard([full], {
      runs: [run("r1", { state: "waiting_approval", mode: "write" })],
      approvals: [{ id: "ap1", run_id: "r1", channel_id: "c1", requested_by: "a1", title: "Merge", detail: "", options: [], state: "pending" }],
    })
    await userEvent.click(screen.getByRole("button", { name: /^Fix login/ }))
    const dialog = await screen.findByRole("dialog", { name: "Fix login" })
    expect(dialog).toHaveTextContent("It drops the password.")
    expect(within(dialog).getByRole("region", { name: "Scope" })).toHaveTextContent("web/src/login.tsx")
    expect(within(dialog).getByRole("region", { name: "Checks" })).toHaveTextContent("npm test")
    expect(within(dialog).getByRole("region", { name: "Acceptance criteria" })).toHaveTextContent("Login works")
    expect(within(dialog).getByRole("link", { name: "Open timeline" })).toBeInTheDocument()
    expect(within(dialog).getByRole("link", { name: "Open approval" })).toBeInTheDocument()
    expect(dialog).toHaveTextContent("codex/default")
  })

  it("starts a Todo task from its detail, and cancels a running one", async () => {
    const start = vi.spyOn(api, "startTask").mockResolvedValue(task("a", "running"))
    const cancel = vi.spyOn(api, "cancelTask").mockResolvedValue(task("c", "cancelled"))
    await renderBoard()
    await userEvent.click(screen.getByRole("button", { name: /^First todo/ }))
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Start" }))
    expect(start).toHaveBeenCalledWith("a")
    await userEvent.keyboard("{Escape}")
    await userEvent.click(screen.getByRole("button", { name: /^Running one/ }))
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel task" }))
    expect(cancel).toHaveBeenCalledWith("c")
  })

  it("shows the server's message when a start is refused", async () => {
    vi.spyOn(api, "startTask").mockRejectedValue(new Error("Lane x is not in @coder's chain"))
    await renderBoard()
    await userEvent.click(screen.getByRole("button", { name: /^First todo/ }))
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Start" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Lane x is not in @coder's chain")
  })
})

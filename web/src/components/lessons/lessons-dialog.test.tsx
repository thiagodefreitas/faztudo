import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { api } from "../../api/client"
import { qk } from "../../state/keys"
import type { Channel, Lesson, Member } from "../../types"
import { LessonsButton, LessonsDialog } from "./lessons-dialog"

const human: Member = { id: "ada", kind: "human", handle: "ada", display_name: "Ada", presence: "online" }
const dev = { id: "c1", name: "dev" } as Channel
const older: Lesson = {
  id: "l1",
  persona: "coder",
  channel_id: "",
  text: "Keep diffs small.",
  source_message_id: "",
  created_by: "ada",
  created_at: "2026-10-20T09:00:00Z",
  updated_at: "2026-10-20T09:00:00Z",
}
const newer: Lesson = { ...older, id: "l2", channel_id: "c1", text: "Run the checks.", created_at: "2026-10-21T09:00:00Z", updated_at: "2026-10-21T09:00:00Z" }
const other: Lesson = { ...older, id: "l3", persona: "reviewer", text: "Be brief." }

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function setup(lessons: Lesson[], ui?: (persona: string) => React.ReactNode) {
  vi.spyOn(api, "me").mockResolvedValue(human)
  vi.spyOn(api, "channels").mockResolvedValue([dev])
  vi.spyOn(api, "lessons").mockResolvedValue(lessons)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>{ui ? ui("coder") : <LessonsDialog persona="coder" open onOpenChange={() => {}} />}</QueryClientProvider>,
  )
  return client
}

describe("LessonsDialog", () => {
  it("lists the persona's lessons newest first with their scope", async () => {
    setup([older, newer, other])
    const items = await screen.findAllByRole("listitem")
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveTextContent("Run the checks.")
    expect(items[0]).toHaveTextContent("#dev")
    expect(items[1]).toHaveTextContent("Keep diffs small.")
    expect(items[1]).toHaveTextContent("Everywhere")
  })

  it("explains what lessons are when there are none", async () => {
    setup([other])
    expect(await screen.findByText(/A lesson is a short correction/)).toBeInTheDocument()
  })

  it("edits a lesson in place with Enter and Escape ends the edit only", async () => {
    const user = userEvent.setup()
    const patch = vi.spyOn(api, "patchLesson").mockResolvedValue({ ...newer, text: "Run all the checks." })
    const client = setup([older, newer])
    const row = (await screen.findByText("Run the checks.")).closest("li")
    if (!row) throw new Error("row missing")
    await user.click(row.querySelector("button") as HTMLElement)
    const field = screen.getByLabelText("Lesson text")
    expect(field).toHaveValue("Run the checks.")
    await user.keyboard("{Escape}")
    expect(screen.queryByLabelText("Lesson text")).toBeNull()
    expect(screen.getByRole("dialog")).toBeInTheDocument()
    await user.click(screen.getAllByRole("button", { name: "Edit" })[0] as HTMLElement)
    const again = screen.getByLabelText("Lesson text")
    await user.clear(again)
    await user.type(again, "Run all the checks.{Enter}")
    await waitFor(() => expect(patch).toHaveBeenCalledWith("l2", { text: "Run all the checks." }))
    expect(await screen.findByText("Run all the checks.")).toBeInTheDocument()
    await waitFor(() => expect(client.getQueryData<Lesson[]>(qk.lessons)?.find((item) => item.id === "l2")?.text).toBe("Run all the checks."))
  })

  it("keeps the delete for five seconds and Undo cancels it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const del = vi.spyOn(api, "deleteLesson").mockResolvedValue()
    setup([older, newer])
    await screen.findByText("Run the checks.")
    await user.click(screen.getAllByRole("button", { name: "Delete" })[0] as HTMLElement)
    expect(screen.getByRole("status")).toHaveTextContent("Lesson deleted.")
    act(() => void vi.advanceTimersByTime(4000))
    expect(del).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: "Undo" }))
    act(() => void vi.advanceTimersByTime(6000))
    expect(del).not.toHaveBeenCalled()
    expect(screen.getByText("Run the checks.")).toBeInTheDocument()
  })

  it("sends the DELETE after five seconds and drops the lesson from the cache", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const del = vi.spyOn(api, "deleteLesson").mockResolvedValue()
    const client = setup([older, newer])
    await screen.findByText("Run the checks.")
    await user.click(screen.getAllByRole("button", { name: "Delete" })[0] as HTMLElement)
    act(() => void vi.advanceTimersByTime(5000))
    await waitFor(() => expect(del).toHaveBeenCalledWith("l2"))
    await waitFor(() => expect(client.getQueryData<Lesson[]>(qk.lessons)?.map((item) => item.id)).toEqual(["l1"]))
    expect(screen.queryByText("Run the checks.")).toBeNull()
  })

  it("sends a waiting delete when the panel closes", async () => {
    const user = userEvent.setup()
    const del = vi.spyOn(api, "deleteLesson").mockResolvedValue()
    setup([newer], () => <LessonsButton persona="coder" />)
    await user.click(await screen.findByRole("button", { name: "Lessons for @coder" }))
    await user.click(await screen.findByRole("button", { name: "Delete" }))
    await user.click(screen.getByRole("button", { name: "Close" }))
    await waitFor(() => expect(del).toHaveBeenCalledWith("l2"))
  })
})

describe("LessonsButton", () => {
  it("shows how many lessons the persona has", async () => {
    setup([older, newer, other], () => <LessonsButton persona="coder" />)
    await waitFor(() => expect(screen.getByRole("button", { name: "Lessons for @coder" })).toHaveTextContent("Lessons (2)"))
  })
})

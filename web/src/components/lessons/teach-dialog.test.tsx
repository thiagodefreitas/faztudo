import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiError, api } from "../../api/client"
import { qk } from "../../state/keys"
import type { Lesson, Member } from "../../types"
import { TeachDialog } from "./teach-dialog"

const lesson: Lesson = {
  id: "l1",
  persona: "coder",
  channel_id: "c1",
  text: "Keep diffs small.",
  source_message_id: "m1",
  created_by: "ada",
  created_at: "2026-10-22T09:00:00Z",
  updated_at: "2026-10-22T09:00:00Z",
}
const human: Member = { id: "ada", kind: "human", handle: "ada", display_name: "Ada", presence: "online" }

afterEach(() => vi.restoreAllMocks())

function setup(onOpenChange = vi.fn()) {
  vi.spyOn(api, "me").mockResolvedValue(human)
  vi.spyOn(api, "lessons").mockResolvedValue([])
  vi.spyOn(api, "channels").mockResolvedValue([])
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(qk.lessons, [])
  render(
    <QueryClientProvider client={client}>
      <TeachDialog persona="coder" channelId="c1" channelName="dev" sourceMessageId="m1" open onOpenChange={onOpenChange} />
    </QueryClientProvider>,
  )
  return { client, onOpenChange }
}

describe("TeachDialog", () => {
  it("saves a lesson for this channel with Enter and confirms", async () => {
    const user = userEvent.setup()
    const create = vi.spyOn(api, "createLesson").mockResolvedValue(lesson)
    const { client } = setup()
    const field = await screen.findByPlaceholderText("What should @coder do differently next time?")
    expect(screen.getByLabelText(/In this channel/)).toBeChecked()
    await user.type(field, "Keep diffs small.{Enter}")
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({ persona: "coder", text: "Keep diffs small.", channel_id: "c1", source_message_id: "m1" }),
    )
    expect(await screen.findByRole("status")).toHaveTextContent("@coder will see this in its next runs.")
    expect(screen.getByRole("button", { name: "Open lessons" })).toBeInTheDocument()
    expect(client.getQueryData<Lesson[]>(qk.lessons)).toEqual([lesson])
  })

  it("leaves the channel out when the lesson applies everywhere", async () => {
    const user = userEvent.setup()
    const create = vi.spyOn(api, "createLesson").mockResolvedValue({ ...lesson, channel_id: "" })
    setup()
    await user.type(await screen.findByLabelText("Lesson"), "Answer in English")
    await user.click(screen.getByLabelText("Everywhere"))
    await user.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(create).toHaveBeenCalledWith({ persona: "coder", text: "Answer in English", source_message_id: "m1" }))
  })

  it("counts characters, refuses an empty or too long text and shows why the daemon refused", async () => {
    const user = userEvent.setup()
    vi.spyOn(api, "createLesson").mockRejectedValue(new ApiError(404, "not_found", "channel not found"))
    setup()
    const save = screen.getByRole("button", { name: "Save" })
    expect(save).toBeDisabled()
    const field = screen.getByLabelText("Lesson")
    await user.click(field)
    await user.paste("x".repeat(501))
    expect(screen.getByText("501/500")).toBeInTheDocument()
    expect(save).toBeDisabled()
    await user.clear(field)
    await user.type(field, "ok")
    expect(screen.getByText("2/500")).toBeInTheDocument()
    await user.click(save)
    expect(await screen.findByRole("alert")).toHaveTextContent("channel not found")
  })

  it("closes on Escape", async () => {
    const user = userEvent.setup()
    const { onOpenChange } = setup()
    await screen.findByLabelText("Lesson")
    await user.keyboard("{Escape}")
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})

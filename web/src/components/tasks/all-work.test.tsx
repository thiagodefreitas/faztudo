import { screen, within } from "@testing-library/react"
import { beforeEach, describe, expect, it } from "vitest"
import { qk } from "../../state/keys"
import type { Message } from "../../types"
import { AllWork } from "./all-work"
import { TasksView } from "./tasks-page"
import { ada, channel, renderWithApp, reviewer, run } from "./test-utils"

const recent = new Date(Date.now() - 3600_000).toISOString()
const msg = (id: string, author: string, body: string): Message => ({ id, channel_id: "c1", author_id: author, body, mentions: [], created_at: recent })

beforeEach(() => localStorage.clear())

describe("AllWork", () => {
  it("shows runs in columns with request, channel and a from label", async () => {
    const runs = [
      run("r1", { state: "running", started_at: recent, trigger_message_id: "m1" }),
      run("r2", { state: "waiting_approval", started_at: recent, trigger_message_id: "m2", agent_id: "a1" }),
    ]
    const { client } = await renderWithApp(<AllWork channels={[channel]} />, { runs })
    client.setQueryData(qk.messages("c1"), [msg("m1", ada.id, "ship it\nplease"), msg("m2", reviewer.id, "check this")])
    const running = await screen.findByRole("region", { name: "Running" })
    expect(within(running).getByText("ship it")).toBeInTheDocument()
    expect(running).toHaveTextContent("#dev")
    expect(running).not.toHaveTextContent("from @")
    const needs = screen.getByRole("region", { name: "Needs you" })
    expect(needs).toHaveTextContent("from @reviewer")
  })

  it("shows measured tokens and estimated cost on a card", async () => {
    const measured = run("priced", { state: "done", ended_at: recent, tokens: { input: 1200, output: 300, cache_read: 500, cache_write: 0 }, cost_usd: 0.0045 })
    await renderWithApp(<AllWork channels={[channel]} />, { runs: [measured] })
    const done = await screen.findByRole("region", { name: "Done" })
    expect(done).toHaveTextContent("2,000 tokens - about $0.0045")
  })
})

describe("view toggle", () => {
  it("remembers All work per browser", async () => {
    const { unmount } = await renderWithApp(<TasksView />, { runs: [run("r1", { state: "queued" })] })
    expect(screen.queryByTestId("all-work")).toBeNull()
    screen.getByRole("button", { name: "All work" }).click()
    expect(await screen.findByTestId("all-work")).toBeInTheDocument()
    expect(localStorage.getItem("faztudo.tasks.view")).toBe("all")
    unmount()
    await renderWithApp(<TasksView />)
    expect(await screen.findByTestId("all-work")).toBeInTheDocument()
  })
})

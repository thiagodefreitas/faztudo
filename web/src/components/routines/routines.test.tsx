import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { api } from "../../api/client"
import { qk } from "../../state/keys"
import type { Member, Routine } from "../../types"
import { RoutinesList } from "./routines"

const chief: Member = {
  id: "chief",
  kind: "agent",
  handle: "chief",
  display_name: "Chief of Staff",
  presence: "online",
  agent: { lanes: ["claude/opus"], chief_of_staff: true },
}

const debrief: Routine = {
  handle: "daily-debrief",
  name: "Daily debrief",
  prompt: "",
  persona: "chief",
  channel: "general",
  schedule: "0 18 * * 1-5",
  template: "debrief",
  enabled: true,
  source: "config",
  next_run: "2026-10-19T16:00:00Z",
  last: { at: new Date().toISOString(), status: "ok", detail: "Posted the summary." },
}

const welcome: Routine = {
  handle: "welcome",
  name: "Welcome",
  prompt: "Say hello to the newcomer.",
  persona: "chief",
  channel: "general",
  trigger: "message",
  enabled: false,
  source: "app",
  last: { at: new Date().toISOString(), status: "skipped", detail: "lane claude/opus is in conserve" },
}

afterEach(() => {
  vi.restoreAllMocks()
})

function setup(routines: Routine[]) {
  vi.spyOn(api, "routines").mockResolvedValue(routines)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(qk.members, [chief])
  client.setQueryData(qk.routines, routines)
  render(
    <QueryClientProvider client={client}>
      <RoutinesList />
    </QueryClientProvider>,
  )
}

describe("RoutinesList", () => {
  it("lists each routine with when it runs, who runs it and how the last run ended", () => {
    setup([debrief, welcome])
    const card = screen.getByRole("article", { name: "Daily debrief" })
    expect(within(card).getByText("Weekdays at 18:00")).toBeInTheDocument()
    expect(within(card).getByText("@chief in #general")).toBeInTheDocument()
    expect(within(card).getByText(/what ran, what merged, what failed/)).toBeInTheDocument()
    const last = within(card).getByTestId("last-daily-debrief")
    expect(last).toHaveTextContent("Done")
    expect(last).toHaveTextContent("Posted the summary.")
    expect(within(card).getByText(/^Next:/)).toBeInTheDocument()

    const other = screen.getByRole("article", { name: "Welcome" })
    expect(within(other).getByText("When someone posts in #general")).toBeInTheDocument()
    expect(within(other).getByText("Say hello to the newcomer.")).toBeInTheDocument()
    expect(within(other).getByTestId("last-welcome")).toHaveTextContent("Skipped")
    expect(within(other).getByTestId("last-welcome")).toHaveTextContent("lane claude/opus is in conserve")
    expect(within(other).getByText("Switched off")).toBeInTheDocument()
    expect(within(other).queryByText(/^Next:/)).not.toBeInTheDocument()
  })

  it("switches a routine on and off", async () => {
    const user = userEvent.setup()
    const set = vi.spyOn(api, "setRoutineEnabled").mockResolvedValue({ ...debrief, enabled: false })
    setup([debrief, welcome])
    await user.click(screen.getByRole("switch", { name: "Switch off Daily debrief" }))
    await waitFor(() => expect(set).toHaveBeenCalledWith("daily-debrief", false))
    await user.click(screen.getByRole("switch", { name: "Switch on Welcome" }))
    await waitFor(() => expect(set).toHaveBeenCalledWith("welcome", true))
  })

  it("runs a routine now and says so", async () => {
    const user = userEvent.setup()
    const run = vi.spyOn(api, "runRoutine").mockResolvedValue({ status: "started" })
    setup([debrief])
    await user.click(within(screen.getByRole("article", { name: "Daily debrief" })).getByRole("button", { name: "Run now" }))
    await waitFor(() => expect(run).toHaveBeenCalledWith("daily-debrief"))
    expect(await screen.findByRole("status")).toHaveTextContent("Started Daily debrief.")
  })

  it("shows why a routine could not run", async () => {
    const user = userEvent.setup()
    vi.spyOn(api, "runRoutine").mockRejectedValue(new Error("lane claude/opus is in conserve, so the routine waits"))
    setup([debrief])
    await user.click(screen.getByRole("button", { name: "Run now" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("in conserve")
  })

  it("shows where each routine comes from and deletes only app routines", async () => {
    const user = userEvent.setup()
    const remove = vi.spyOn(api, "deleteRoutine").mockResolvedValue(undefined)
    setup([debrief, welcome])
    const fromFile = screen.getByRole("article", { name: "Daily debrief" })
    expect(within(fromFile).getByText("From lanes.toml")).toBeInTheDocument()
    expect(within(fromFile).queryByRole("button", { name: /Delete/ })).not.toBeInTheDocument()
    const fromApp = screen.getByRole("article", { name: "Welcome" })
    expect(within(fromApp).getByText("Made in the app")).toBeInTheDocument()
    await user.click(within(fromApp).getByRole("button", { name: "Delete Welcome" }))
    await waitFor(() => expect(remove).toHaveBeenCalledWith("welcome"))
  })

  it("explains how to add the first routine", () => {
    setup([])
    expect(screen.getByText(/No routines yet/)).toBeInTheDocument()
    expect(screen.getByText("faztudo init --template solo")).toBeInTheDocument()
  })
})

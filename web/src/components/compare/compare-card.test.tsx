import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { api } from "../../api/client"
import type { CompareGroup, Run } from "../../types"
import { CompareCard } from "./compare-card"

const base: Run = { id: "a", channel_id: "channel", trigger_message_id: "request", agent_id: "coder", lane_id: "codex/default", mode: "write", state: "waiting_approval", worktree: "/tmp/a", diff_stat: { files: 2, insertions: 12, deletions: 3 }, verification: { ok: true, detail: "go test passed" } }
const group: CompareGroup = { id: "compare", channel_id: "channel", message_id: "request", agent_id: "coder", candidates: [{ lane_id: "codex/default", run: base, output_tail: ["A passed"] }, { lane_id: "claude/opus", run: { ...base, id: "b", lane_id: "claude/opus", diff_stat: { files: 1, insertions: 7, deletions: 1 } }, output_tail: ["B passed"] }] }

afterEach(() => vi.restoreAllMocks())

async function renderCard(value = group) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const root = createRootRoute({ component: () => <CompareCard group={value} /> })
  const router = createRouter({ routeTree: root.addChildren([]), history: createMemoryHistory({ initialEntries: ["/"] }), context: {} })
  await router.load()
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  return client
}

describe("CompareCard", () => {
  it("shows both lanes, changes, verification and output, then sends one choice", async () => {
    const user = userEvent.setup()
    const decide = vi.spyOn(api, "decideCompare").mockResolvedValue({ ...group, decision: "merge_a", winner_lane: "codex/default" })
    await renderCard()
    expect(screen.getByRole("region", { name: "Candidate A" })).toHaveTextContent("codex/default")
    expect(screen.getByRole("region", { name: "Candidate B" })).toHaveTextContent("claude/opus")
    expect(screen.getByText(/2 files \| \+12\/-3/)).toBeInTheDocument()
    expect(screen.getAllByText(/Verification: passed/)).toHaveLength(2)
    expect(screen.getByText("A passed")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "View A diff" })).toBeEnabled()
    await user.click(screen.getByRole("button", { name: "Merge A" }))
    expect(decide).toHaveBeenCalledWith("channel", "compare", "merge_a")
  })

  it("waits for both runs and shows a decision error without disabling choices", async () => {
    const user = userEvent.setup()
    await renderCard({ ...group, candidates: [group.candidates[0], { lane_id: "claude/opus", run: { ...base, id: "b", state: "running" } }] })
    expect(screen.getByRole("button", { name: "Combine" })).toBeDisabled()
    cleanup()
    // A finished pair keeps the choices available after a server refusal.
    const decide = vi.spyOn(api, "decideCompare").mockRejectedValue(new Error("The branch moved"))
    await renderCard()
    await user.click(screen.getByRole("button", { name: "Merge A" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("The branch moved")
    expect(decide).toHaveBeenCalledOnce()
    expect(screen.getByRole("button", { name: "Discard both" })).toBeEnabled()
  })
})

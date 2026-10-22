import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiError, api } from "../api/client"
import { qk } from "../state/keys"
import type { Channel, Member, Suggestion } from "../types"
import { SuggestionsSection } from "./suggestions"

const ada: Member = { id: "ada", kind: "human", handle: "ada", display_name: "Ada", presence: "online" }
const coder: Member = { id: "coder", kind: "agent", handle: "coder", display_name: "Coder", presence: "online", agent: { lanes: ["claude/default"] } }
const dev: Channel = { id: "c1", name: "dev", kind: "team", visibility: "public", member_ids: ["ada", "coder"], unread: 0 }

const flaky: Suggestion = {
  id: "s1",
  channel_id: "c1",
  persona: "reviewer",
  title: "Fix the flaky reconnect test",
  detail: "It failed in **3** of 10 runs.",
  evidence: ["web/src/api/stream.test.ts:88", "https://example.com/runs/1"],
  state: "open",
  created_at: new Date(Date.now() - 2 * 3600_000).toISOString(),
}
const docs: Suggestion = { ...flaky, id: "s2", title: "Docs and code disagree", detail: "", evidence: ["docs/a.md:3"], created_at: new Date(Date.now() - 26 * 3600_000).toISOString() }

afterEach(() => vi.restoreAllMocks())

function setup(list: Suggestion[], me: Member = ada) {
  vi.spyOn(api, "suggestions").mockResolvedValue(list)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(qk.me, me)
  client.setQueryData(qk.channels, [dev])
  client.setQueryData(qk.suggestions, list)
  const view = render(
    <QueryClientProvider client={client}>
      <SuggestionsSection />
    </QueryClientProvider>,
  )
  return { client, view }
}

describe("SuggestionsSection", () => {
  it("lists open suggestions with title, persona, channel and age, newest first", () => {
    setup([docs, flaky, { ...flaky, id: "s3", state: "dismissed", title: "Already gone" }])
    expect(screen.getByRole("heading", { name: "Suggestions (2)" })).toBeInTheDocument()
    const rows = screen.getAllByRole("listitem").filter((item) => item.hasAttribute("data-suggestion"))
    expect(rows.map((row) => row.getAttribute("data-suggestion"))).toEqual(["s1", "s2"])
    expect(rows[0]).toHaveTextContent("Fix the flaky reconnect test")
    expect(rows[0]).toHaveTextContent("@reviewer in #dev")
    expect(rows[0]?.querySelector("time")).toHaveTextContent(/^\d+h$/)
    expect(screen.queryByText("Already gone")).not.toBeInTheDocument()
  })

  it("shows nothing when nothing is open, and nothing to an agent", () => {
    const { view } = setup([{ ...flaky, state: "accepted" }])
    expect(view.container).toBeEmptyDOMElement()
    view.unmount()
    const again = setup([flaky], coder)
    expect(again.view.container).toBeEmptyDOMElement()
  })

  it("shows the detail and evidence links on expand", async () => {
    const user = userEvent.setup()
    setup([flaky])
    expect(screen.queryByText("Evidence")).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: /Fix the flaky reconnect test/ }))
    expect(screen.getByText("3").tagName).toBe("STRONG")
    const link = screen.getByRole("link", { name: "https://example.com/runs/1" })
    expect(link).toHaveAttribute("href", "https://example.com/runs/1")
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"))
    expect(screen.getByText("web/src/api/stream.test.ts:88").tagName).toBe("CODE")
  })

  it("makes a task and drops the suggestion from the list", async () => {
    const user = userEvent.setup()
    const accept = vi.spyOn(api, "acceptSuggestion").mockResolvedValue({ ...flaky, state: "accepted", task_id: "t1" })
    setup([flaky, docs])
    await user.click(screen.getByRole("button", { name: /Fix the flaky reconnect test/ }))
    await user.click(screen.getByRole("button", { name: "Make a task" }))
    await waitFor(() => expect(accept).toHaveBeenCalledWith("s1"))
    await waitFor(() => expect(screen.getByRole("heading", { name: "Suggestions (1)" })).toBeInTheDocument())
    expect(screen.queryByText("Fix the flaky reconnect test")).not.toBeInTheDocument()
  })

  it("dismisses with a reason, saying that the scout learns from it", async () => {
    const user = userEvent.setup()
    const dismiss = vi.spyOn(api, "dismissSuggestion").mockResolvedValue({ ...flaky, state: "dismissed", reason: "known flake" })
    setup([flaky])
    await user.click(screen.getByRole("button", { name: /Fix the flaky reconnect test/ }))
    await user.click(screen.getByRole("button", { name: "Dismiss" }))
    expect(screen.getByText(/also teaches @reviewer/)).toHaveTextContent("Do not suggest: ...")
    await user.type(screen.getByLabelText(/Why not/), "  known flake ")
    await user.click(screen.getByRole("button", { name: "Dismiss" }))
    await waitFor(() => expect(dismiss).toHaveBeenCalledWith("s1", { reason: "known flake" }))
    await waitFor(() => expect(screen.queryByRole("heading", { name: /Suggestions/ })).not.toBeInTheDocument())
  })

  it("dismisses without a reason and can cancel the dismissal", async () => {
    const user = userEvent.setup()
    const dismiss = vi.spyOn(api, "dismissSuggestion").mockResolvedValue({ ...flaky, state: "dismissed" })
    setup([flaky])
    await user.click(screen.getByRole("button", { name: /Fix the flaky reconnect test/ }))
    await user.click(screen.getByRole("button", { name: "Dismiss" }))
    await user.click(screen.getByRole("button", { name: "Cancel" }))
    expect(screen.getByRole("button", { name: "Make a task" })).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Dismiss" }))
    await user.click(screen.getByRole("button", { name: "Dismiss" }))
    await waitFor(() => expect(dismiss).toHaveBeenCalledWith("s1", { reason: "" }))
  })

  it("shows why the daemon refused and keeps the suggestion", async () => {
    const user = userEvent.setup()
    vi.spyOn(api, "acceptSuggestion").mockRejectedValue(new ApiError(409, "conflict", "suggestion is already accepted"))
    setup([flaky])
    await user.click(screen.getByRole("button", { name: /Fix the flaky reconnect test/ }))
    await user.click(screen.getByRole("button", { name: "Make a task" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("suggestion is already accepted")
    expect(screen.getByRole("button", { name: "Make a task" })).toBeEnabled()
  })
})

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { api } from "../api/client"
import { applyEvent } from "../state/cache"
import { qk } from "../state/keys"
import type { Approval, Channel, Lane, Member, Message, Run } from "../types"
import { ActivityStrip } from "./activity-strip"

const coder: Member = {
  id: "a1",
  kind: "agent",
  handle: "coder",
  display_name: "Coder",
  presence: "busy",
  agent: { lanes: ["codex/default", "kimi/default"] },
}

const channel = (unread: number): Channel => ({
  id: "c1",
  name: "dev",
  kind: "team",
  visibility: "public",
  member_ids: ["a1"],
  unread,
})

const running: Run = {
  id: "r1",
  channel_id: "c1",
  trigger_message_id: "m1",
  agent_id: "a1",
  lane_id: "codex/default",
  mode: "write",
  state: "running",
  started_at: new Date(Date.now() - 125_000).toISOString(),
}

const trouble: Lane = {
  id: "kimi/default",
  cli: "kimi",
  cost_class: "cheap",
  capacity: 1,
  running: 0,
  health: "unavailable",
  windows: [],
  runs_today: 0,
}

const waiting: Approval = {
  id: "ap1",
  run_id: "r0",
  channel_id: "c1",
  requested_by: "a1",
  title: "Merge",
  detail: "",
  options: [],
  state: "pending",
}

let lastClient: QueryClient

function renderStrip(unread: number, data: { runs?: Run[]; approvals?: Approval[]; lanes?: Lane[]; summary?: string } = {}, onOpenRun = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  lastClient = client
  client.setQueryData(qk.runs, data.runs ?? [])
  client.setQueryData(qk.approvals, data.approvals ?? [])
  client.setQueryData(qk.lanes, data.lanes ?? [])
  client.setQueryData(qk.members, [coder])
  client.setQueryData(qk.messages("c1"), [{ id: "m1", channel_id: "c1", author_id: "h", body: "@coder Fix the login check", mentions: [], created_at: "2026-10-18T10:00:00.000Z" } as Message])
  client.setQueryData(qk.summary("c1"), { channel_id: "c1", text: data.summary ?? "" })
  render(
    <QueryClientProvider client={client}>
      <ActivityStrip channel={channel(unread)} onOpenRun={onOpenRun} />
    </QueryClientProvider>,
  )
  return onOpenRun
}

describe("ActivityStrip", () => {
  afterEach(() => vi.restoreAllMocks())

  it("renders nothing for a quiet, fully read channel", () => {
    renderStrip(0)
    expect(screen.queryByRole("region", { name: "Channel activity" })).not.toBeInTheDocument()
  })

  it("stays hidden for runs that ended or belong to another channel", () => {
    renderStrip(0, {
      runs: [
        { ...running, id: "r2", state: "done" },
        { ...running, id: "r3", state: "waiting_approval" },
        { ...running, id: "r4", state: "cancelled" },
        { ...running, id: "r5", channel_id: "c2" },
      ],
    })
    expect(screen.queryByRole("region", { name: "Channel activity" })).not.toBeInTheDocument()
  })

  it("shows who works on what, with the handle and the time, and opens the run", async () => {
    const user = userEvent.setup()
    const open = renderStrip(0, { runs: [running, { ...running, id: "r6", state: "queued" }, { ...running, id: "r7", state: "verifying" }] })
    const button = screen.getAllByRole("button", { name: /Coder.*Fix the login check/ })[0]!
    expect(button).toHaveTextContent("@coder")
    expect(button).toHaveTextContent("2m")
    expect(screen.getAllByRole("button", { name: "Stop the run of @coder" })).toHaveLength(3)
    await user.click(button)
    expect(open).toHaveBeenCalledWith("r1")
  })

  // The server only acknowledges a cancel. The runs are refetched, and the
  // cancelled run itself arrives through the stream; nothing but runs may
  // land in the runs cache.
  it("stops a run from the strip and drops it once the cancel lands", async () => {
    const user = userEvent.setup()
    const cancel = vi.spyOn(api, "cancelRun").mockResolvedValue({ ok: true })
    const refetch = vi.spyOn(api, "runs").mockResolvedValue([running])
    renderStrip(0, { runs: [running] })
    await user.click(screen.getByRole("button", { name: "Stop the run of @coder" }))
    expect(cancel).toHaveBeenCalledWith("r1")
    await waitFor(() => expect(refetch).toHaveBeenCalled())
    expect(lastClient.getQueryData<Run[]>(qk.runs)?.map((run) => run.id)).toEqual(["r1"])
    expect(screen.getByRole("button", { name: "Stop the run of @coder" })).toBeEnabled()
    applyEvent(lastClient, {
      seq: 2,
      id: "01EVAAAAAAAAAAAAAAAAAAAAAC",
      version: 1,
      type: "run.updated",
      actor: "system",
      channel_id: "c1",
      ts: "2026-10-18T12:02:00.000Z",
      payload: { ...running, state: "cancelled", ended_at: "2026-10-18T12:02:00.000Z" },
    })
    await waitFor(() => expect(screen.queryByRole("region", { name: "Channel activity" })).not.toBeInTheDocument())
  })

  it("shows approvals waiting and lanes in trouble", () => {
    renderStrip(0, { approvals: [waiting], lanes: [trouble] })
    expect(screen.getByRole("button", { name: "1 approval waiting for you" })).toBeInTheDocument()
    expect(screen.getByText("kimi/default")).toBeInTheDocument()
    expect(screen.getByText(/unavailable/)).toBeInTheDocument()
  })

  it("catches up from the channel summary and can be dismissed", async () => {
    const user = userEvent.setup()
    renderStrip(4, { summary: "Coder merged the login fix. Reviewer is next.", approvals: [waiting] })
    const region = screen.getByRole("region", { name: "Channel activity" })
    expect(region).toHaveTextContent("Since you were away: 4 new messages. Earlier: Coder merged the login fix. 1 waiting for you.")
    await user.click(screen.getByRole("button", { name: "Dismiss" }))
    expect(screen.queryByText(/Since you were away/)).not.toBeInTheDocument()
  })
})

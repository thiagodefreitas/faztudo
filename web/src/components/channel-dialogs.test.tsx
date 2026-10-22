import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiError, api } from "../api/client"
import { qk } from "../state/keys"
import type { Channel, Member } from "../types"
import { ChannelSettingsDialog, CreateChannelDialog } from "./channel-dialogs"

const channel: Channel = {
  id: "01BRZ3NDEKTSV4RRFFQ69G5BB1",
  name: "faztudo-dev",
  kind: "team",
  visibility: "public",
  topic: "old topic",
  member_ids: [],
  unread: 0,
}

const agents: Member[] = [
  { id: "01BRZ3NDEKTSV4RRFFQ69G5BA1", kind: "agent", handle: "coder", display_name: "Coder", presence: "online" },
  { id: "01BRZ3NDEKTSV4RRFFQ69G5BA2", kind: "agent", handle: "reviewer", display_name: "Reviewer", presence: "online" },
]

function wrap(node: React.ReactNode) {
  const qc = new QueryClient()
  qc.setQueryData(qk.channels, [channel])
  render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
  return qc
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("ChannelSettingsDialog", () => {
  it("edits the policy of a Signal binding", async () => {
    const user = userEvent.setup()
    vi.spyOn(api, "bridgeBindings").mockResolvedValue([{ conversation: "group:people", recipients: "group:people", outbound_agents: "draft" }])
    const patch = vi.spyOn(api, "patchBridgeBinding").mockResolvedValue({ conversation: "group:people", recipients: "group:people", outbound_agents: "off" })
    wrap(<ChannelSettingsDialog channel={channel} agents={agents} open onOpenChange={() => undefined} />)
    await user.click(screen.getByRole("tab", { name: "Bridge" }))
    const select = await screen.findByRole("combobox", { name: "Agent messages to group:people" })
    expect(select).toHaveValue("draft")
    await user.selectOptions(select, "Do not send")
    await waitFor(() => expect(patch).toHaveBeenCalledWith(channel.id, "group:people", "off"))
  })
  it("saves topic, repo_path and test_command", async () => {
    const user = userEvent.setup()
    const next = { ...channel, topic: "new", repo_path: "/r", test_command: "go test ./..." }
    const spy = vi.spyOn(api, "patchChannel").mockResolvedValue(next)
    const onOpenChange = vi.fn()
    const qc = wrap(<ChannelSettingsDialog channel={channel} agents={agents} open onOpenChange={onOpenChange} />)
    expect(screen.getByText(/Local git repository that write runs/)).toBeInTheDocument()
    expect(screen.getByText(/for example go test/)).toBeInTheDocument()
    const topic = screen.getByLabelText("Topic")
    await user.clear(topic)
    await user.type(topic, "new")
    await user.type(screen.getByLabelText("Repository path"), "/r")
    await user.type(screen.getByLabelText("Test command"), "go test ./...")
    await user.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(spy).toHaveBeenCalledWith(channel.id, {
      topic: "new",
      repo_path: "/r",
      test_command: "go test ./...",
      default_agent_id: "",
    })
    expect(qc.getQueryData<Channel[]>(qk.channels)?.[0]?.topic).toBe("new")
  })

  it("lists the channel's lane preferences", () => {
    wrap(
      <ChannelSettingsDialog
        channel={{ ...channel, lane_overrides: { coder: "claude/default" } }}
        agents={agents}
        open
        onOpenChange={() => undefined}
      />,
    )
    expect(screen.getByText("@coder: claude/default")).toBeInTheDocument()
    expect(screen.getByText(/Clear one with/)).toBeInTheDocument()
  })

  it("offers None plus every agent as the default agent and sends the choice", async () => {
    const user = userEvent.setup()
    const spy = vi.spyOn(api, "patchChannel").mockResolvedValue({ ...channel, default_agent_id: agents[1]?.id })
    wrap(<ChannelSettingsDialog channel={channel} agents={agents} open onOpenChange={() => undefined} />)
    const select = screen.getByLabelText("Default agent")
    expect(Array.from((select as HTMLSelectElement).options).map((option) => option.text)).toEqual(["None", "Coder", "Reviewer"])
    expect(select).toHaveValue("")
    await user.selectOptions(select, "Reviewer")
    await user.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(spy).toHaveBeenCalled())
    expect(spy).toHaveBeenCalledWith(channel.id, expect.objectContaining({ default_agent_id: agents[1]?.id }))
  })

  it("starts on the saved default agent and clears it with None", async () => {
    const user = userEvent.setup()
    const spy = vi.spyOn(api, "patchChannel").mockResolvedValue(channel)
    wrap(<ChannelSettingsDialog channel={{ ...channel, default_agent_id: agents[0]?.id }} agents={agents} open onOpenChange={() => undefined} />)
    const select = screen.getByLabelText("Default agent")
    expect(select).toHaveValue(agents[0]?.id)
    await user.selectOptions(select, "None")
    await user.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(spy).toHaveBeenCalled())
    expect(spy).toHaveBeenCalledWith(channel.id, expect.objectContaining({ default_agent_id: "" }))
  })

  it("shows the server error inline for an invalid repo path and stays open", async () => {
    const user = userEvent.setup()
    vi.spyOn(api, "patchChannel").mockRejectedValue(new ApiError(400, "bad_request", "repo_path is not a git work tree"))
    const onOpenChange = vi.fn()
    wrap(<ChannelSettingsDialog channel={channel} agents={agents} open onOpenChange={onOpenChange} />)
    await user.type(screen.getByLabelText("Repository path"), "/nope")
    await user.click(screen.getByRole("button", { name: "Save" }))
    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent("repo_path is not a git work tree")
    expect(screen.getByLabelText("Repository path")).toHaveAttribute("aria-invalid", "true")
    expect(onOpenChange).not.toHaveBeenCalled()
  })
})

describe("CreateChannelDialog", () => {
  it("rejects a bad name without calling the server", async () => {
    const user = userEvent.setup()
    const spy = vi.spyOn(api, "createChannel")
    wrap(<CreateChannelDialog open onOpenChange={() => undefined} onCreated={() => undefined} />)
    await user.type(screen.getByLabelText("Name"), "Bad Name")
    await user.click(screen.getByRole("button", { name: "Create" }))
    expect(await screen.findByRole("alert")).toHaveTextContent(/lowercase letters, digits and dashes/i)
    expect(spy).not.toHaveBeenCalled()
  })

  it("creates a channel and reports it", async () => {
    const user = userEvent.setup()
    const created = { ...channel, id: "01BRZ3NDEKTSV4RRFFQ69G5BB2", name: "new-room" }
    const spy = vi.spyOn(api, "createChannel").mockResolvedValue(created)
    const onCreated = vi.fn()
    const qc = wrap(<CreateChannelDialog open onOpenChange={() => undefined} onCreated={onCreated} />)
    await user.type(screen.getByLabelText("Name"), "new-room")
    await user.type(screen.getByLabelText("Topic"), "hello")
    await user.click(screen.getByRole("button", { name: "Create" }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created))
    expect(spy).toHaveBeenCalledWith({ name: "new-room", kind: "team", visibility: "public", topic: "hello" })
    expect(qc.getQueryData<Channel[]>(qk.channels)).toHaveLength(2)
  })

  it("sends the creator and every ticked agent, then sets the default agent", async () => {
    const user = userEvent.setup()
    const me: Member = { id: "01BRZ3NDEKTSV4RRFFQ69G5BH1", kind: "human", handle: "ada", display_name: "Ada", presence: "online" }
    const created = { ...channel, id: "01BRZ3NDEKTSV4RRFFQ69G5BB3", name: "room", member_ids: [] }
    const spy = vi.spyOn(api, "createChannel").mockResolvedValue(created)
    const patch = vi.spyOn(api, "patchChannel").mockResolvedValue({ ...created, default_agent_id: agents[1]!.id })
    const onCreated = vi.fn()
    const qc = wrap(<CreateChannelDialog open onOpenChange={() => undefined} onCreated={onCreated} />)
    qc.setQueryData(qk.members, agents)
    qc.setQueryData(qk.me, me)
    const coder = await screen.findByRole("checkbox", { name: /Coder/ })
    expect(coder).toBeChecked()
    expect(screen.getByRole("checkbox", { name: /Reviewer/ })).toBeChecked()
    await user.click(coder)
    const select = screen.getByLabelText("Default agent")
    expect(within(select).getAllByRole("option")).toHaveLength(1)
    await user.type(screen.getByLabelText("Name"), "room")
    await user.click(screen.getByRole("button", { name: "Create" }))
    await waitFor(() => expect(onCreated).toHaveBeenCalled())
    expect(spy).toHaveBeenCalledWith({ name: "room", kind: "team", visibility: "public", member_ids: [me.id, agents[1]!.id] })
    expect(patch).toHaveBeenCalledWith(created.id, { default_agent_id: agents[1]!.id })
    expect(onCreated.mock.calls[0]![0].default_agent_id).toBe(agents[1]!.id)
  })

  it("None and All change the ticked agents and the default select follows", async () => {
    const user = userEvent.setup()
    const created = { ...channel, id: "01BRZ3NDEKTSV4RRFFQ69G5BB4", name: "room" }
    const spy = vi.spyOn(api, "createChannel").mockResolvedValue(created)
    const patch = vi.spyOn(api, "patchChannel")
    const qc = wrap(<CreateChannelDialog open onOpenChange={() => undefined} onCreated={() => undefined} />)
    qc.setQueryData(qk.members, agents)
    qc.setQueryData(qk.me, { id: "h", kind: "human", handle: "ada", display_name: "Ada", presence: "online" })
    await user.click(await screen.findByRole("button", { name: "None" }))
    expect(screen.getByRole("checkbox", { name: /Coder/ })).not.toBeChecked()
    expect(screen.getByLabelText("Default agent")).toBeDisabled()
    await user.type(screen.getByLabelText("Name"), "room")
    await user.click(screen.getByRole("button", { name: "Create" }))
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ name: "room", kind: "team", visibility: "public", member_ids: ["h"] }))
    expect(patch).not.toHaveBeenCalled()
  })

  it("shows a server error for a bad repo path", async () => {
    const user = userEvent.setup()
    vi.spyOn(api, "createChannel").mockRejectedValue(new ApiError(400, "bad_request", "repo_path is not a git work tree"))
    const onCreated = vi.fn()
    wrap(<CreateChannelDialog open onOpenChange={() => undefined} onCreated={onCreated} />)
    await user.type(screen.getByLabelText("Name"), "room")
    await user.type(screen.getByLabelText("Repository path (optional)"), "/x")
    await user.click(screen.getByRole("button", { name: "Create" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("not a git work tree")
    expect(onCreated).not.toHaveBeenCalled()
  })
})

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { api } from "../api/client"
import { qk } from "../state/keys"
import type { Channel, Member, Org, Project } from "../types"
import { CreateProjectDialog, CreateTeamChannelDialog } from "./project-dialogs"

const ada: Member = { id: "ada", kind: "human", handle: "ada", display_name: "Ada", presence: "online" }
const bob: Member = { id: "bob", kind: "human", handle: "bob", display_name: "Bob", presence: "online" }
const agent = (handle: string, name: string): Member => ({
  id: handle,
  kind: "agent",
  handle,
  display_name: name,
  presence: "idle",
  agent: { lanes: ["codex/default"], role: `${name} role` },
})
const coder = agent("coder", "Coder")
const reviewer = agent("reviewer", "Reviewer")
const writer = agent("writer", "Writer")

const org: Org = {
  director_id: ada.id,
  departments: [{ handle: "engineering", display_name: "Engineering", lead: "coder", members: ["coder", "reviewer"] }],
  projects: [{ handle: "faztudo", name: "Faztudo", lead: "coder", channels: ["faztudo-dev"], departments: ["engineering"], specialists: [] }],
}

const channel = (id: string, name: string, over: Partial<Channel> = {}): Channel => ({
  id,
  name,
  kind: "project",
  visibility: "public",
  member_ids: [ada.id],
  unread: 0,
  ...over,
})

afterEach(() => {
  vi.restoreAllMocks()
})

async function mount(ui: React.ReactNode, channels: Channel[] = []) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(qk.me, ada)
  client.setQueryData(qk.members, [ada, bob, coder, reviewer, writer])
  client.setQueryData(qk.org, org)
  client.setQueryData(qk.channels, channels)
  const router = createRouter({
    routeTree: createRootRoute({ component: () => <>{ui}</> }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  })
  await router.load()
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return client
}

describe("CreateProjectDialog", () => {
  it("derives the handle and the first channel from the name, then creates the project and its channels", async () => {
    const user = userEvent.setup()
    const created: Project = { handle: "launch-week", name: "Launch week", lead: "writer", channels: ["launch-week-dev"], departments: ["engineering"], specialists: ["writer"] }
    const createProject = vi.spyOn(api, "createProject").mockResolvedValue(created)
    const createChannel = vi.spyOn(api, "createChannel").mockResolvedValue(channel("c-new", "launch-week-dev"))
    const patchChannel = vi.spyOn(api, "patchChannel").mockResolvedValue(channel("c-new", "launch-week-dev", { default_agent_id: writer.id }))
    const onCreated = vi.fn()
    await mount(<CreateProjectDialog open onOpenChange={() => undefined} onCreated={onCreated} />)

    await user.type(screen.getByLabelText("Name"), "Launch week")
    expect(screen.getByLabelText("Handle")).toHaveValue("launch-week")
    expect(screen.getByLabelText("First channels")).toHaveValue("launch-week-dev")
    await user.selectOptions(screen.getByLabelText("Lead"), "writer")
    await user.click(screen.getByLabelText("Engineering"))
    await user.click(screen.getByLabelText("Writer"))
    expect(screen.getByText(/4 on the team, led by @writer/)).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Create project" }))

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created))
    expect(createProject).toHaveBeenCalledWith({
      handle: "launch-week",
      name: "Launch week",
      lead: "writer",
      channels: ["launch-week-dev"],
      departments: ["engineering"],
      specialists: ["writer"],
    })
    expect(createChannel).toHaveBeenCalledTimes(1)
    const body = createChannel.mock.calls[0]![0]
    expect(body.name).toBe("launch-week-dev")
    expect(body.kind).toBe("project")
    expect(body.member_ids).toEqual(expect.arrayContaining([ada.id, writer.id, coder.id, reviewer.id]))
    expect(patchChannel).toHaveBeenCalledWith("c-new", { default_agent_id: writer.id })
  })

  it("rejects a bad handle and a bad channel name before calling the server", async () => {
    const user = userEvent.setup()
    const createProject = vi.spyOn(api, "createProject")
    await mount(<CreateProjectDialog open onOpenChange={() => undefined} onCreated={() => undefined} />)
    await user.click(screen.getByRole("button", { name: "Create project" }))
    expect(screen.getByText("Give the project a name.")).toBeInTheDocument()
    await user.type(screen.getByLabelText("Name"), "Launch")
    await user.clear(screen.getByLabelText("Handle"))
    await user.type(screen.getByLabelText("Handle"), "bad handle")
    await user.click(screen.getByRole("button", { name: "Create project" }))
    expect(screen.getByText(/Use letters, digits/)).toBeInTheDocument()
    await user.clear(screen.getByLabelText("Handle"))
    await user.type(screen.getByLabelText("Handle"), "launch")
    await user.clear(screen.getByLabelText("First channels"))
    await user.type(screen.getByLabelText("First channels"), "Bad Name")
    await user.click(screen.getByRole("button", { name: "Create project" }))
    expect(screen.getByText(/Bad: use lowercase/)).toBeInTheDocument()
    expect(createProject).not.toHaveBeenCalled()
  })

  it("shows a conflict from the server on the handle", async () => {
    const user = userEvent.setup()
    const { ApiError } = await import("../api/client")
    vi.spyOn(api, "createProject").mockRejectedValue(new ApiError(409, "conflict", "a project with handle faztudo exists"))
    await mount(<CreateProjectDialog open onOpenChange={() => undefined} onCreated={() => undefined} />)
    await user.type(screen.getByLabelText("Name"), "Faztudo")
    await user.click(screen.getByRole("button", { name: "Create project" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("a project with handle faztudo exists")
  })
})

describe("CreateTeamChannelDialog", () => {
  it("starts with the team picked, the lead as default agent, and lists the channel under the project", async () => {
    const user = userEvent.setup()
    const made = channel("c9", "faztudo-design", { member_ids: [ada.id, coder.id, reviewer.id] })
    const createChannel = vi.spyOn(api, "createChannel").mockResolvedValue(made)
    const patchChannel = vi.spyOn(api, "patchChannel").mockResolvedValue({ ...made, default_agent_id: coder.id })
    const patchProject = vi.spyOn(api, "patchProject").mockResolvedValue({ ...org.projects[0]!, channels: ["faztudo-dev", "faztudo-design"] })
    const onCreated = vi.fn()
    await mount(<CreateTeamChannelDialog project={org.projects[0]!} open onOpenChange={() => undefined} onCreated={onCreated} />)

    expect(screen.getByLabelText("Ada")).toBeChecked()
    expect(screen.getByLabelText("Ada")).toBeDisabled()
    expect(screen.getByLabelText("Coder")).toBeChecked()
    expect(screen.getByLabelText("Reviewer")).toBeChecked()
    expect(screen.getByLabelText("Writer")).not.toBeChecked()
    expect(screen.getByLabelText("Default agent")).toHaveValue(coder.id)

    await user.click(screen.getByLabelText("Reviewer"))
    await user.click(screen.getByLabelText("Bob"))
    await user.type(screen.getByLabelText("Name"), "faztudo-design")
    await user.type(screen.getByLabelText("Topic"), "Screens")
    await user.click(screen.getByRole("button", { name: "Create channel" }))

    await waitFor(() => expect(onCreated).toHaveBeenCalled())
    const body = createChannel.mock.calls[0]![0]
    expect(body).toMatchObject({ name: "faztudo-design", kind: "project", visibility: "public", topic: "Screens" })
    expect(body.member_ids).toEqual(expect.arrayContaining([ada.id, coder.id, bob.id]))
    expect(body.member_ids).not.toContain(reviewer.id)
    expect(patchChannel).toHaveBeenCalledWith("c9", { default_agent_id: coder.id })
    expect(patchProject).toHaveBeenCalledWith("faztudo", { channels: ["faztudo-dev", "faztudo-design"] })
  })

  it("drops the default agent when that agent is unpicked", async () => {
    const user = userEvent.setup()
    await mount(<CreateTeamChannelDialog project={org.projects[0]!} open onOpenChange={() => undefined} onCreated={() => undefined} />)
    await user.click(screen.getByLabelText("Coder"))
    expect(screen.getByLabelText("Default agent")).toHaveValue("")
  })
})

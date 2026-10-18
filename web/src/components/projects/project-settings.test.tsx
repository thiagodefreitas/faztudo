import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { api, ApiError } from "../../api/client"
import { qk } from "../../state/keys"
import type { Channel, Member, Org } from "../../types"
import { ProjectSettingsPage } from "./project-settings"

const human: Member = { id: "h", kind: "human", handle: "human", display_name: "Human", presence: "online" }
const agent: Member = { id: "a", kind: "agent", handle: "coder", display_name: "Coder", presence: "idle", agent: { lanes: ["x"] } }
const channel: Channel = { id: "c", name: "work", kind: "project", visibility: "public", member_ids: ["h", "a"], unread: 0, test_command: "go test ./...", default_agent_id: "a" }
const org: Org = { director_id: "h", departments: [], projects: [{ handle: "p", name: "Project", channels: ["work"], departments: [], specialists: [], lead: "coder" }] }

afterEach(() => vi.restoreAllMocks())

async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(qk.org, org)
  client.setQueryData(qk.channels, [channel])
  client.setQueryData(qk.members, [human, agent])
  const root = createRootRoute({ component: () => <ProjectSettingsPage /> })
  const route = createRoute({ getParentRoute: () => root, path: "/projects/$handle/settings" })
  const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: ["/projects/p/settings"] }) })
  await router.load()
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  return client
}

describe("project settings", () => {
  it("saves project and channel settings through their PATCH endpoints", async () => {
    const user = userEvent.setup()
    const patchProject = vi.spyOn(api, "patchProject").mockResolvedValue({ ...org.projects[0]!, name: "Renamed" })
    const patchChannel = vi.spyOn(api, "patchChannel").mockResolvedValue(channel)
    await mount()
    await user.clear(screen.getByLabelText("Name"))
    await user.type(screen.getByLabelText("Name"), "Renamed")
    await user.click(screen.getByRole("button", { name: "Save project" }))
    await waitFor(() => expect(patchProject).toHaveBeenCalledWith("p", { name: "Renamed", repo_path: "", lead: "coder", channels: ["work"] }))
    const row = screen.getByRole("form", { name: "#work settings" })
    await user.clear(within(row).getByLabelText("Test command"))
    await user.type(within(row).getByLabelText("Test command"), "go vet ./...")
    await user.click(within(row).getByRole("button", { name: "Save #work" }))
    await waitFor(() => expect(patchChannel).toHaveBeenCalledWith("c", { test_command: "go vet ./...", default_agent_id: "a" }))
  })

  it("shows server validation errors and archives through PATCH", async () => {
    const user = userEvent.setup()
    const patch = vi.spyOn(api, "patchProject").mockRejectedValueOnce(new ApiError(400, "bad_request", "repo_path must be a git work tree")).mockResolvedValue({ ...org.projects[0]!, archived: true })
    await mount()
    await user.click(screen.getByRole("button", { name: "Save project" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("git work tree")
    await user.click(screen.getByRole("button", { name: "Archive project" }))
    await waitFor(() => expect(patch).toHaveBeenLastCalledWith("p", { archived: true }))
  })
})

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { api } from "../api/client"
import { qk } from "../state/keys"
import type { Member, Org, Project } from "../types"
import { OrganizationPage } from "./organization"

const ada: Member = { id: "ada", kind: "human", handle: "ada", display_name: "Ada", presence: "online" }
const agent = (handle: string, name: string, role: string): Member => ({
  id: handle,
  kind: "agent",
  handle,
  display_name: name,
  presence: "online",
  agent: { lanes: ["claude/opus"], role },
})
const coder = agent("coder", "Coder", "Implements changes")
const reviewer = agent("reviewer", "Reviewer", "Reviews diffs")
const writer = agent("writer", "Writer", "Writes docs")

const project: Project = {
  handle: "faztudo",
  name: "Faztudo",
  channels: ["faztudo-dev"],
  departments: ["engineering"],
  specialists: ["writer"],
}
const org: Org = {
  director_id: ada.id,
  departments: [
    { handle: "engineering", display_name: "Engineering", lead: "coder", members: ["coder", "reviewer"] },
    { handle: "product", display_name: "Product", members: [] },
  ],
  projects: [project],
}

afterEach(() => {
  vi.restoreAllMocks()
})

async function setup(members: Member[] = [ada, coder, reviewer, writer], organization: Org = org) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(qk.me, ada)
  client.setQueryData(qk.members, members)
  client.setQueryData(qk.org, organization)
  client.setQueryData(qk.computers, [{ id: "coder", state: "idle", disk_bytes: 1048576, disk_soft_max: 1073741824 }])
  client.setQueryData(qk.lanes, [])
  client.setQueryData(qk.runs, [])
  client.setQueryData(qk.approvals, [])
  const router = createRouter({
    routeTree: createRootRoute({ component: OrganizationPage }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  })
  await router.load()
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

describe("OrganizationPage", () => {
  it("shows computer status and confirms reset consequences", async () => {
    const user = userEvent.setup()
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true)
    const reset = vi.spyOn(api, "resetComputer").mockResolvedValue({ id: "coder", state: "idle", disk_bytes: 0, disk_soft_max: 1073741824 })
    vi.spyOn(api, "computers").mockResolvedValue([{ id: "coder", state: "idle", disk_bytes: 0, disk_soft_max: 1073741824 }])
    await setup()
    const section = await screen.findByRole("region", { name: "Agent computers" })
    expect(section).toHaveTextContent("@coder")
    expect(section).toHaveTextContent("1.0 MB used")
    await user.click(within(section).getByRole("button", { name: "Reset @coder" }))
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("cannot undo OAuth changes"))
    await waitFor(() => expect(reset).toHaveBeenCalledWith("coder"))
  })
  it("lists archived projects separately and can unarchive them", async () => {
    const user = userEvent.setup()
    const patch = vi.spyOn(api, "patchProject").mockResolvedValue({ ...project, archived: false })
    await setup([ada, coder, reviewer, writer], { ...org, projects: [{ ...project, archived: true }] })
    const archived = await screen.findByRole("region", { name: "Archived" })
    expect(within(archived).getByText("Faztudo")).toBeInTheDocument()
    await user.click(within(archived).getByRole("button", { name: "Unarchive" }))
    await waitFor(() => expect(patch).toHaveBeenCalledWith("faztudo", { archived: false }))
  })
  it("shows the Director, departments with their lead, and projects with assignments", async () => {
    await setup()
    expect(await screen.findByTestId("director")).toHaveTextContent("Ada")
    const engineering = screen.getByRole("article", { name: "Engineering" })
    const rows = within(engineering).getAllByRole("listitem")
    expect(rows.map((row) => row.getAttribute("data-agent"))).toEqual(["coder", "reviewer"])
    expect(rows[0]).toHaveTextContent("Lead")
    expect(rows[0]).toHaveTextContent("Implements changes")

    const card = screen.getByRole("article", { name: "Faztudo" })
    expect(within(card).getByText("#faztudo-dev")).toBeInTheDocument()
    expect(within(card).getByText("2 agents")).toBeInTheDocument()
    expect(within(card).getByText("Writer")).toBeInTheDocument()
  })

  it("shows the Chief of Staff apart from the departments, and links to the routines", async () => {
    const chief: Member = { ...agent("chief", "Chief", "Routes requests"), agent: { lanes: ["claude/opus"], role: "Routes requests", chief_of_staff: true } }
    await setup([ada, chief, coder, reviewer, writer])
    const section = await screen.findByTestId("chief-of-staff")
    expect(within(section).getByText("Chief")).toBeInTheDocument()
    expect(within(section).getByText("Chief of Staff", { selector: "span" })).toBeInTheDocument()
    expect(within(section).getByText(/not addressed to anyone/)).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Routines" })).toHaveAttribute("href", "/routines")
  })

  it("has no Chief of Staff section when nobody is one", async () => {
    await setup()
    await screen.findByTestId("director")
    expect(screen.queryByTestId("chief-of-staff")).not.toBeInTheDocument()
  })

  it("assigns from the menu and removes with the button", async () => {
    const user = userEvent.setup()
    const assign = vi.spyOn(api, "assign").mockResolvedValue(project)
    const unassign = vi.spyOn(api, "unassign").mockResolvedValue(project)
    await setup()

    const menu = await screen.findByLabelText("Assign to Faztudo")
    // Engineering and Writer are assigned already, so only the others are offered.
    expect(within(menu).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Assign...",
      "Product",
      "Coder",
      "Reviewer",
    ])
    await user.selectOptions(menu, "specialist:reviewer")
    await waitFor(() => expect(assign).toHaveBeenCalledWith("faztudo", { kind: "specialist", handle: "reviewer" }))

    await user.click(screen.getByRole("button", { name: "Remove Writer from Faztudo" }))
    await waitFor(() => expect(unassign).toHaveBeenCalledWith("faztudo", "specialist", "writer"))
    await user.click(screen.getByRole("button", { name: "Remove Engineering from Faztudo" }))
    await waitFor(() => expect(unassign).toHaveBeenCalledWith("faztudo", "department", "engineering"))
  })

  it("shows the server's message when a change fails", async () => {
    const user = userEvent.setup()
    vi.spyOn(api, "assign").mockRejectedValue(new Error("only a human can change assignments"))
    await setup()
    await user.selectOptions(await screen.findByLabelText("Assign to Faztudo"), "department:product")
    expect(await screen.findByRole("alert")).toHaveTextContent("only a human can change assignments")
  })
})

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { api } from "../../api/client"
import { qk } from "../../state/keys"
import type { Approval, Channel, Member, Message, Org, Run } from "../../types"
import { ApprovalsInbox } from "./approvals-page"

const ada: Member = { id: "h1", kind: "human", handle: "ada", display_name: "Ada", presence: "online" }
const agent = (handle: string, name: string): Member => ({
  id: `id-${handle}`,
  kind: "agent",
  handle,
  display_name: name,
  presence: "idle",
  agent: { lanes: ["codex/default"] },
})
const coder = agent("coder", "Coder")
const reviewer = agent("reviewer", "Reviewer")

const channel = (id: string, name: string): Channel => ({
  id,
  name,
  kind: "team",
  visibility: "public",
  member_ids: [],
  unread: 0,
  last_seq: 0,
})

const org: Org = {
  director_id: ada.id,
  departments: [],
  projects: [
    { handle: "site", name: "Site", channels: ["web"], departments: [], specialists: [] },
    { handle: "backend", name: "Backend", channels: ["api"], departments: [], specialists: [] },
  ],
}

const pending = (id: string, channel_id: string, title: string, requested_by: string, run_id?: string): Approval => ({
  id,
  channel_id,
  requested_by,
  title,
  detail: `Detail of ${title}`,
  options: [
    { key: "push", label: "Push", style: "primary" },
    { key: "hold", label: "Hold" },
  ],
  state: "pending",
  ...(run_id ? { run_id } : {}),
})

const question: Message = {
  id: "01QUESTION",
  channel_id: "c1",
  author_id: coder.id,
  body: "Which test command should I run?",
  mentions: [],
  options: ["go test ./...", "make check"],
  created_at: new Date().toISOString(),
}

async function renderInbox(focus?: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(qk.org, org)
  client.setQueryData(qk.members, [ada, coder, reviewer])
  client.setQueryData(qk.channels, [channel("c1", "web"), channel("c2", "api")])
  client.setQueryData(qk.runs, [{ id: "r2", channel_id: "c2", agent_id: reviewer.id, state: "waiting_approval" } as Run])
  client.setQueryData(qk.approvals, [
    pending("02WEB", "c1", "Push the login fix", coder.id),
    pending("01API", "c2", "Push the api change", reviewer.id, "r2"),
    { ...pending("00OLD", "c1", "Already decided", coder.id), state: "resolved" },
  ])
  client.setQueryData<Message[]>(qk.messages("c1"), [question])
  client.setQueryData<Message[]>(qk.messages("c2"), [])
  const rootRoute = createRootRoute({ component: () => <ApprovalsInbox focus={focus} /> })
  const router = createRouter({
    routeTree: rootRoute.addChildren([createRoute({ getParentRoute: () => rootRoute, path: "/c/$channelId" })]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
    context: {},
  })
  await router.load()
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  await screen.findByRole("heading", { name: "Needs you" })
}

describe("ApprovalsInbox", () => {
  it("lists pending approvals oldest first and skips decided ones", async () => {
    await renderInbox()
    const list = within(screen.getByRole("region", { name: "Approvals waiting" }))
    const rows = list.getAllByRole("button", { expanded: false })
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent("Push the api change")
    expect(rows[1]).toHaveTextContent("Push the login fix")
    expect(screen.queryByText("Already decided")).not.toBeInTheDocument()
    expect(screen.getByText("2 approvals, 1 question")).toBeInTheDocument()
  })

  it("shows project and channel on each row", async () => {
    await renderInbox()
    expect(screen.getByText("Backend / #api")).toBeInTheDocument()
    expect(screen.getByText("Site / #web")).toBeInTheDocument()
  })

  it("filters by project and by agent", async () => {
    const user = userEvent.setup()
    await renderInbox()
    await user.selectOptions(screen.getByRole("combobox", { name: "Project" }), "site")
    expect(screen.getByText("Push the login fix")).toBeInTheDocument()
    expect(screen.queryByText("Push the api change")).not.toBeInTheDocument()
    await user.selectOptions(screen.getByRole("combobox", { name: "Project" }), "")
    await user.selectOptions(screen.getByRole("combobox", { name: "Agent" }), reviewer.id)
    expect(screen.getByText("Push the api change")).toBeInTheDocument()
    expect(screen.queryByText("Push the login fix")).not.toBeInTheDocument()
    expect(screen.queryByText("Which test command should I run?")).not.toBeInTheDocument()
    await user.selectOptions(screen.getByRole("combobox", { name: "Project" }), "site")
    expect(screen.getByText("Nothing matches these filters.")).toBeInTheDocument()
  })

  it("expands a row into the full card", async () => {
    const user = userEvent.setup()
    await renderInbox()
    expect(screen.queryByRole("article")).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: /Push the login fix/ }))
    expect(screen.getByRole("article", { name: "Push the login fix" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Push$/ })).toBeInTheDocument()
  })

  it("opens the approval a notification points at", async () => {
    await renderInbox("01API")
    expect(screen.getByRole("article", { name: "Push the api change" })).toBeInTheDocument()
    expect(screen.queryByRole("article", { name: "Push the login fix" })).not.toBeInTheDocument()
  })

  it("shows a resolve refusal and leaves the approval usable", async () => {
    const user = userEvent.setup()
    const resolve = vi.spyOn(api, "resolveApproval").mockRejectedValueOnce(new Error("The channel repository has uncommitted changes"))
    try {
      await renderInbox("01API")
      await user.click(screen.getByRole("button", { name: /Push$/ }))
      expect(await screen.findByRole("alert")).toHaveTextContent("The channel repository has uncommitted changes")
      expect(screen.getByRole("article", { name: "Push the api change" })).toBeInTheDocument()
      expect(screen.getByRole("button", { name: /Hold/ })).toBeEnabled()
    } finally {
      resolve.mockRestore()
    }
  })

  it("lists unanswered questions with their options", async () => {
    await renderInbox()
    const questions = within(screen.getByRole("region", { name: "Questions waiting" }))
    expect(questions.getByText("Which test command should I run?")).toBeInTheDocument()
    expect(questions.getByRole("button", { name: /go test/ })).toBeInTheDocument()
    expect(questions.getByRole("link", { name: "Open channel" })).toBeInTheDocument()
  })

  it("says so when nothing waits", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    client.setQueryData(qk.org, org)
    client.setQueryData(qk.members, [ada])
    client.setQueryData(qk.channels, [])
    client.setQueryData(qk.runs, [])
    client.setQueryData(qk.approvals, [])
    const rootRoute = createRootRoute({ component: () => <ApprovalsInbox /> })
    const router = createRouter({ routeTree: rootRoute.addChildren([]), history: createMemoryHistory({ initialEntries: ["/"] }), context: {} })
    await router.load()
    render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    )
    expect(await screen.findByText("Nothing needs you right now.")).toBeInTheDocument()
  })
})

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { qk } from "../state/keys"
import type { Channel, Lane, Member, Message, Run } from "../types"
import { InboxPage } from "./inbox"

const ada: Member = { id: "ada", kind: "human", handle: "ada", display_name: "Ada", presence: "online" }
const bob: Member = { id: "bob", kind: "human", handle: "bob", display_name: "Bob", presence: "idle" }
const coder: Member = {
  id: "coder",
  kind: "agent",
  handle: "coder",
  display_name: "Coder",
  presence: "online",
  agent: { lanes: ["claude/default"] },
}

const general: Channel = {
  id: "c1",
  name: "general",
  kind: "team",
  visibility: "public",
  member_ids: [ada.id, bob.id, coder.id],
  unread: 0,
}
const coderDm: Channel = {
  id: "c2",
  name: "dm-ada-coder",
  kind: "direct",
  visibility: "direct",
  member_ids: [ada.id, coder.id],
  unread: 3,
}

function message(id: string, channel: string, author: Member, at: string, body: string): Message {
  return { id, channel_id: channel, author_id: author.id, body, mentions: [], created_at: at }
}

async function setup(opts: { channels?: Channel[]; lanes?: Lane[]; runs?: Run[]; lastMentions?: string[]; lastAt?: Record<string, number> } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(qk.me, ada)
  client.setQueryData(qk.members, [ada, bob, coder])
  client.setQueryData(qk.channels, opts.channels ?? [general, coderDm])
  client.setQueryData(qk.lanes, opts.lanes ?? [])
  client.setQueryData(qk.suggestions, [])
  client.setQueryData(qk.runs, opts.runs ?? [])
  client.setQueryData(qk.messages("c1"), [message("m1", "c1", bob, new Date(Date.now() - 3 * 3600_000).toISOString(), "Notes for the **week**")])
  client.setQueryData(qk.messages("c3"), [message("m3", "c3", bob, new Date(Date.now() - 2 * 3600_000).toISOString(), "Later")])
  const reply = message("m2", "c2", coder, new Date(Date.now() - (opts.lastAt?.c2 ?? 60_000)).toISOString(), "## Done\n\nThe patch is ready")
  client.setQueryData(qk.messages("c2"), [{ ...reply, mentions: opts.lastMentions ?? [] }])
  const rootRoute = createRootRoute({ component: InboxPage })
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: "/c/$channelId" }),
      createRoute({ getParentRoute: () => rootRoute, path: "/settings/devices" }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  })
  await router.load()
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

afterEach(() => {
  localStorage.clear()
  vi.unstubAllGlobals()
})

const lane = (health: Lane["health"]): Lane =>
  ({ id: "claude/default", cli: "claude", cost_class: "standard", capacity: 1, running: 0, health, windows: [], runs_today: 0 }) as Lane

describe("InboxPage", () => {
  it("sorts by last activity and shows previews with an author prefix in channels", async () => {
    await setup()
    const list = await screen.findByTestId("inbox-list")
    const rows = within(list).getAllByRole("link")
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent("Coder")
    expect(rows[0]).toHaveTextContent("Done The patch is ready")
    expect(rows[0]).not.toHaveTextContent("##")
    expect(within(rows[0] as HTMLElement).getByLabelText("3 unread")).toBeInTheDocument()
    expect(rows[1]).toHaveTextContent("# general")
    expect(rows[1]).toHaveTextContent("Bob: Notes for the week")
    expect(rows[1]).toHaveTextContent(/\dh/)
  })

  it("shows a team icon for a channel and no pill without hidden unread rows", async () => {
    await setup()
    expect(await screen.findByTestId("team-icon")).toBeInTheDocument()
    expect(screen.queryByText(/ unread$/)).not.toBeInTheDocument()
  })

  it("greets the Director with the date and hides the pinned row until there is a pin", async () => {
    await setup()
    expect(await screen.findByRole("heading", { level: 1, name: /^Good (morning|afternoon|evening), Ada$/ })).toBeInTheDocument()
    expect(screen.queryByRole("region", { name: "Pinned agents" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Pin a chat" })).toBeInTheDocument()
  })

  it("offers to create the first channel and points at doctor when every lane is unknown", async () => {
    await setup({ channels: [], lanes: [lane("unknown")] })
    const empty = await screen.findByTestId("inbox-empty")
    expect(within(empty).getByText("No channels yet")).toBeInTheDocument()
    expect(screen.getByTestId("inbox-doctor")).toHaveTextContent("faztudo doctor")
    await userEvent.click(within(empty).getByRole("button", { name: "Create your first channel" }))
    expect(await screen.findByRole("dialog", { name: "Create channel" })).toBeInTheDocument()
  })

  it("leaves out the doctor line when a lane is healthy", async () => {
    await setup({ channels: [], lanes: [lane("available")] })
    await screen.findByTestId("inbox-empty")
    expect(screen.queryByTestId("inbox-doctor")).not.toBeInTheDocument()
  })

  it("pads the list below the last row while the unread pill shows", async () => {
    class Hidden {
      constructor(private cb: IntersectionObserverCallback) {}
      observe(target: Element) {
        this.cb([{ target, isIntersecting: false } as IntersectionObserverEntry], this as never)
      }
      disconnect() {}
      unobserve() {}
    }
    vi.stubGlobal("IntersectionObserver", Hidden)
    await setup()
    expect(await screen.findByText("1 unread")).toBeInTheDocument()
    const list = within(screen.getByTestId("inbox-list")).getAllByRole("list").find((el) => el.hasAttribute("data-padded"))
    expect(list).toHaveClass("pb-16")
  })

  it("filters by unread, agents and channels and says so when nothing matches", async () => {
    await setup({ channels: [general, { ...coderDm, unread: 0 }] })
    const list = await screen.findByTestId("inbox-list")
    const group = screen.getByRole("group", { name: "Filter chats" })
    await userEvent.click(within(group).getByRole("button", { name: "Unread" }))
    expect(within(list).queryAllByRole("link")).toHaveLength(0)
    expect(screen.getByTestId("inbox-filter-empty")).toHaveTextContent("all caught up")
    await userEvent.click(within(group).getByRole("button", { name: "Agents" }))
    expect(within(list).getAllByRole("link")).toHaveLength(1)
    expect(within(list).getByRole("link")).toHaveTextContent("Coder")
    await userEvent.click(within(group).getByRole("button", { name: "Channels" }))
    expect(within(list).getByRole("link")).toHaveTextContent("# general")
    await userEvent.click(within(group).getByRole("button", { name: "All" }))
    expect(within(list).getAllByRole("link")).toHaveLength(2)
  })

  it("puts a chat with a pinned agent first, then orders by last activity", async () => {
    const other: Channel = { ...general, id: "c3", name: "later", unread: 0 }
    localStorage.setItem("faztudo.pins", JSON.stringify([coder.id]))
    await setup({ channels: [general, other, coderDm], lastAt: { c2: 5 * 3600_000 } })
    const rows = within(await screen.findByTestId("inbox-list")).getAllByRole("link")
    expect(rows[0]).toHaveTextContent("Coder")
  })

  it("shows the author in a direct chat preview, a live dot while an agent runs there, and a mention badge", async () => {
    const run = { id: "r1", channel_id: "c2", trigger_message_id: "m", agent_id: "coder", lane_id: "claude/default", mode: "read", state: "running" }
    await setup({ runs: [run as never], lastMentions: [ada.id] })
    const list = await screen.findByTestId("inbox-list")
    const rows = within(list).getAllByRole("link").filter((row) => row.hasAttribute("data-channel"))
    expect(rows[0]).toHaveTextContent("Coder: Done The patch is ready")
    expect(within(rows[0] as HTMLElement).getByTestId("live-dot")).toBeInTheDocument()
    expect(within(rows[0] as HTMLElement).getByTestId("mention-badge")).toBeInTheDocument()
    expect(within(rows[1] as HTMLElement).queryByTestId("live-dot")).not.toBeInTheDocument()
    expect(within(rows[1] as HTMLElement).queryByTestId("mention-badge")).not.toBeInTheDocument()
  })

  it("lists pinned agents with their names", async () => {
    localStorage.setItem("faztudo.pins", JSON.stringify([coder.id]))
    await setup()
    const pinned = await screen.findByRole("region", { name: "Pinned agents" })
    expect(within(pinned).getByRole("button", { name: "Coder" })).toBeInTheDocument()
    expect(within(pinned).getByRole("button", { name: "Pin agents" })).toBeInTheDocument()
  })
})

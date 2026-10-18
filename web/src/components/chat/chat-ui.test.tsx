import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { describe, expect, it, vi } from "vitest"
import { qk } from "../../state/keys"
import type { Approval, Member, Message, Run } from "../../types"
import { MessageList } from "../message-list"
import { FilterChips } from "./filter-chips"
import type { ChatFilter } from "./filters"
import { ThreadsPanel } from "./threads-panel"

const view = vi.hoisted(() => ({ range: null as { startIndex: number; endIndex: number } | null, scrolled: [] as number[] }))

// jsdom has no layout, so the virtualizer would render no rows.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count, getItemKey }: { count: number; getItemKey: (index: number) => string }) => ({
    getTotalSize: () => count * 88,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, key: getItemKey(index), start: index * 88, end: index * 88 + 88 })),
    measureElement: () => undefined,
    scrollToIndex: (index: number) => view.scrolled.push(index),
    range: view.range,
  }),
}))

// The run card needs a router and tooltips; this test is about the list around it.
vi.mock("../run-card", () => ({ RunCard: () => <div>run card</div> }))

const ada: Member = { id: "ada", kind: "human", handle: "ada", display_name: "Ada", presence: "online" }
const coder: Member = { id: "coder", kind: "agent", handle: "coder", display_name: "Coder", presence: "online", agent: { lanes: [] } }

function msg(id: string, author: Member, at: string, extra: Partial<Message> = {}): Message {
  return { id, channel_id: "c1", author_id: author.id, body: `body ${id}`, mentions: [], created_at: at, ...extra }
}

const messages = [
  msg("m1", ada, "2026-10-18T09:00:00"),
  msg("m2", coder, "2026-10-18T10:00:00", { run_id: "r1" }),
  msg("m3", coder, "2026-10-18T10:30:00", { mentions: [ada.id], attachments: [{ id: "f", name: "a.txt", content_type: "text/plain", size: 1 }] }),
]
const run: Run = {
  id: "r1",
  channel_id: "c1",
  trigger_message_id: "m1",
  agent_id: coder.id,
  lane_id: "claude/default",
  mode: "write",
  state: "failed",
  ended_at: "2026-10-18T10:20:00",
}
const approval = { id: "ap", run_id: "r1", channel_id: "c1", requested_by: coder.id, title: "Merge change", detail: "", options: [], state: "pending" } as Approval

function client(extra: Message[] = []) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  qc.setQueryData(qk.messages("c1"), [...messages, ...extra])
  qc.setQueryData(qk.messagePins("c1"), [])
  qc.setQueryData(qk.channels, [])
  qc.setQueryData(qk.members, [ada, coder])
  qc.setQueryData(qk.runs, [run])
  qc.setQueryData(qk.approvals, [approval])
  qc.setQueryData(qk.me, ada)
  qc.setQueryData(qk.notices, [])
  qc.setQueryData(qk.pending("c1"), [])
  qc.setQueryData(qk.summary("c1"), { channel_id: "c1", text: "Coder is fixing login. More later." })
  return qc
}

function List({ qc, unread, onMarkRead }: { qc: QueryClient; unread: number; onMarkRead: () => void }) {
  const [filter, setFilter] = useState<ChatFilter>("all")
  return (
    <QueryClientProvider client={qc}>
      <FilterChips value={filter} onChange={setFilter} />
      <MessageList channelId="c1" onRetry={() => undefined} filter={filter} unread={unread} onMarkRead={onMarkRead} />
    </QueryClientProvider>
  )
}

describe("catch-up in the message list", () => {
  it("shows the New divider and the card before the first unread message", async () => {
    view.range = null
    const onMarkRead = vi.fn()
    render(<List qc={client()} unread={2} onMarkRead={onMarkRead} />)
    expect(screen.getByRole("separator", { name: "New" })).toBeInTheDocument()
    const card = screen.getByRole("region", { name: "Catch up" })
    expect(card).toHaveTextContent("2 new messages from Coder.")
    expect(card).toHaveTextContent("1 run failed.")
    expect(card).toHaveTextContent("1 waiting on you.")
    expect(card).toHaveTextContent("Earlier: Coder is fixing login.")
    // The card sits between the New divider and the first unread message.
    const order = [...document.querySelectorAll("[data-index]")].map((el) => el.textContent ?? "")
    const newAt = order.findIndex((text) => text === "New" || text.startsWith("New"))
    const cardAt = order.findIndex((text) => text.includes("Mark read"))
    expect(cardAt).toBe(newAt + 1)
    await userEvent.click(screen.getByRole("button", { name: "Mark read" }))
    expect(onMarkRead).toHaveBeenCalled()
  })

  it("scrolls to a run from its link", async () => {
    view.scrolled = []
    render(<List qc={client()} unread={2} onMarkRead={() => undefined} />)
    await userEvent.click(screen.getByRole("button", { name: "Coder failed" }))
    expect(view.scrolled.length).toBeGreaterThan(0)
  })

  it("is hidden with nothing unread", () => {
    render(<List qc={client()} unread={0} onMarkRead={() => undefined} />)
    expect(screen.queryByRole("region", { name: "Catch up" })).not.toBeInTheDocument()
    expect(screen.queryByRole("separator", { name: "New" })).not.toBeInTheDocument()
  })

  it("offers a jump to the first unread message only when it is off screen", async () => {
    view.scrolled = []
    view.range = { startIndex: 0, endIndex: 3 }
    const { unmount } = render(<List qc={client()} unread={2} onMarkRead={() => undefined} />)
    // Rows: day, m1, new, catchup, m2, m3 -> New is index 2, on screen.
    expect(screen.queryByRole("button", { name: "Jump to first unread" })).not.toBeInTheDocument()
    unmount()
    view.range = { startIndex: 4, endIndex: 5 }
    render(<List qc={client()} unread={2} onMarkRead={() => undefined} />)
    await userEvent.click(screen.getByRole("button", { name: "Jump to first unread" }))
    expect(view.scrolled).toContain(2)
    view.range = null
  })

  it("filters over the loaded messages from the chips", async () => {
    view.range = null
    render(<List qc={client()} unread={0} onMarkRead={() => undefined} />)
    expect(screen.getByText("body m1")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Files" }))
    expect(screen.queryByText("body m1")).not.toBeInTheDocument()
    expect(screen.getByText("body m3")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Mentions of me" }))
    expect(screen.getByText("body m3")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Runs" }))
    expect(screen.queryByText("body m3")).not.toBeInTheDocument()
    expect(screen.getByText("body m2")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Decisions" }))
    expect(screen.getByText("body m2")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "All" }))
    expect(screen.getByText("body m1")).toBeInTheDocument()
  })
})

describe("ThreadsPanel", () => {
  it("lists threads and opens one", async () => {
    const root = msg("t1", ada, "2026-10-18T08:00:00", { body: "Plan the **release**", reply_count: 2 })
    const reply = msg("t2", coder, "2026-10-18T11:00:00", { thread_id: "t1" })
    const qc = client([root, reply])
    const onOpen = vi.fn()
    render(
      <QueryClientProvider client={qc}>
        <ThreadsPanel channelId="c1" unread={1} onOpen={onOpen} onClose={() => undefined} />
      </QueryClientProvider>,
    )
    const button = screen.getByRole("button", { name: /Plan the release/ })
    expect(button).toHaveTextContent("2 replies")
    expect(screen.getByRole("img", { name: "Unread replies" })).toBeInTheDocument()
    await userEvent.click(button)
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "t1" }))
  })

  it("says when there are no threads", () => {
    render(
      <QueryClientProvider client={client()}>
        <ThreadsPanel channelId="c1" unread={0} onOpen={() => undefined} onClose={() => undefined} />
      </QueryClientProvider>,
    )
    expect(screen.getByText("No threads yet.")).toBeInTheDocument()
  })
})

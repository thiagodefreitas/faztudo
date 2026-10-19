import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { api } from "../api/client"
import { qk } from "../state/keys"
import type { CompareGroup, Member, Message, NoticeItem } from "../types"
import type { PendingMessage } from "../state/queries"
import { comparePollInterval, MessageList } from "./message-list"

// jsdom has no layout, so the virtualizer would render no rows.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count, getItemKey }: { count: number; getItemKey: (index: number) => string }) => ({
    getTotalSize: () => count * 88,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, key: getItemKey(index), start: index * 88 })),
    measureElement: () => undefined,
    scrollToIndex: () => undefined,
  }),
}))

const ada: Member = {
  id: "01ARZ3NDEKTSV4RRFFQ69G5AA1",
  kind: "human",
  handle: "ada",
  display_name: "Ada",
  presence: "online",
}
const coder: Member = {
  id: "01ARZ3NDEKTSV4RRFFQ69G5AA2",
  kind: "agent",
  handle: "coder",
  display_name: "Coder",
  presence: "online",
  agent: { lanes: ["claude/default"] },
}

function message(id: string, author: Member, at: string, body: string): Message {
  return { id, channel_id: "c1", author_id: author.id, body, mentions: [], created_at: at }
}

const reviewer: Member = {
  id: "01ARZ3NDEKTSV4RRFFQ69G5AA3",
  kind: "agent",
  handle: "reviewer",
  display_name: "Reviewer",
  presence: "online",
  agent: { lanes: ["codex/default"] },
}

function renderList(
  messages: Message[] = [],
  replies: Message[] = [],
  extra: { pinned?: string[]; focusId?: string; onOpenThread?: (message: Message) => void; notices?: NoticeItem[] } = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  client.setQueryData(qk.messages("c1"), messages)
  client.setQueryData(
    qk.messagePins("c1"),
    (extra.pinned ?? []).map((id) => ({
      channel_id: "c1",
      message_id: id,
      pinned_by: ada.id,
      pinned_at: "2026-10-18T11:00:00.000Z",
      message: messages.find((item) => item.id === id),
    })),
  )
  for (const root of messages.filter((item) => item.options)) {
    client.setQueryData(qk.thread(root.id), { root, replies })
  }
  client.setQueryData(qk.channels, [])
  client.setQueryData(qk.members, [ada, coder, reviewer])
  client.setQueryData(qk.runs, [])
  client.setQueryData(qk.me, ada)
  client.setQueryData(qk.notices, extra.notices ?? [])
  client.setQueryData(qk.pending("c1"), [])
  render(
    <QueryClientProvider client={client}>
      <MessageList
        channelId="c1"
        onRetry={() => undefined}
        {...(extra.focusId ? { focusId: extra.focusId } : {})}
        {...(extra.onOpenThread ? { onOpenThread: extra.onOpenThread } : {})}
      />
    </QueryClientProvider>,
  )
  return client
}

describe("MessageList", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("polls only while a comparison is running", () => {
    const group = { decision: undefined, candidates: [{ run: { state: "running" } }, { run: { state: "waiting_approval" } }] } as CompareGroup
    expect(comparePollInterval(undefined)).toBe(false)
    expect(comparePollInterval([group])).toBe(5000)
    expect(comparePollInterval([{ ...group, candidates: [{ run: { state: "verifying" } }, { run: { state: "done" } }] } as CompareGroup])).toBe(5000)
    expect(comparePollInterval([{ ...group, candidates: [{ run: { state: "done" } }, { run: { state: "failed" } }] } as CompareGroup])).toBe(false)
    expect(comparePollInterval([{ ...group, decision: "merge_a" }])).toBe(false)
  })

  it("shows an empty channel", () => {
    renderList()
    expect(screen.getByText("No messages yet.")).toBeInTheDocument()
  })

  it("groups consecutive messages from one author within five minutes", () => {
    renderList([
      message("01CRZ3NDEKTSV4RRFFQ69G5CC1", ada, "2026-10-18T10:00:00.000Z", "first"),
      message("01CRZ3NDEKTSV4RRFFQ69G5CC2", ada, "2026-10-18T10:02:00.000Z", "second"),
      message("01CRZ3NDEKTSV4RRFFQ69G5CC3", coder, "2026-10-18T10:03:00.000Z", "third"),
      message("01CRZ3NDEKTSV4RRFFQ69G5CC4", ada, "2026-10-18T10:20:00.000Z", "fourth"),
    ])
    // Headers: Ada, Coder, Ada again after the gap. The second Ada line is grouped.
    // The phone layout adds its own avatar at the end of each group.
    const headers = screen.getAllByTestId("avatar").filter((el) => el.getAttribute("class")?.includes("max-sm:hidden"))
    expect(headers).toHaveLength(3)
    const transcript = screen.getByTestId("transcript")
    expect(within(transcript).getAllByText("Ada")).toHaveLength(2)
    expect(within(transcript).getAllByText("Coder")).toHaveLength(1)
    expect(screen.getByText("second")).toBeInTheDocument()
  })

  it("collapses agent-to-agent messages into one line that expands", async () => {
    const note = { ...message("01CRZ3NDEKTSV4RRFFQ69G5CC1", coder, "2026-10-18T10:00:00.000Z", "patch is ready"), mentions: [reviewer.id] }
    renderList([note])
    expect(screen.queryByText("patch is ready")).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: /Coder messaged Reviewer/ }))
    expect(screen.getByText("patch is ready")).toBeInTheDocument()
  })

  it("counts several agent messages in one line", () => {
    const base = { mentions: [reviewer.id] }
    renderList([
      { ...message("01CRZ3NDEKTSV4RRFFQ69G5CC1", coder, "2026-10-18T10:00:00.000Z", "one"), ...base },
      { ...message("01CRZ3NDEKTSV4RRFFQ69G5CC2", coder, "2026-10-18T10:01:00.000Z", "two"), ...base },
      { ...message("01CRZ3NDEKTSV4RRFFQ69G5CC3", coder, "2026-10-18T10:02:00.000Z", "three"), ...base },
    ])
    expect(screen.getByRole("button", { name: /3 messages between Coder and Reviewer/ })).toBeInTheDocument()
  })

  it("never collapses a message that mentions a human", () => {
    renderList([{ ...message("01CRZ3NDEKTSV4RRFFQ69G5CC1", coder, "2026-10-18T10:00:00.000Z", "@ada look"), mentions: [ada.id] }])
    expect(screen.getByText("@ada look")).toBeInTheDocument()
  })

  it("renders the options of a question and marks the answered one", () => {
    const ask = { ...message("01CRZ3NDEKTSV4RRFFQ69G5CC1", coder, "2026-10-18T10:00:00.000Z", "@ada which?"), mentions: [ada.id], options: ["fast", "safe"] }
    const answer = { ...message("01CRZ3NDEKTSV4RRFFQ69G5CC2", ada, "2026-10-18T10:01:00.000Z", "B: safe"), thread_id: ask.id }
    renderList([ask], [answer])
    expect(screen.getByRole("button", { name: /B\s*safe/ })).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByRole("button", { name: /A\s*fast/ })).toBeDisabled()
  })

  it("shows attachments: an image inline and another file as a card", () => {
    const withFiles: Message = {
      ...message("01CRZ3NDEKTSV4RRFFQ69G5CC1", ada, "2026-10-18T10:00:00.000Z", ""),
      attachments: [
        { id: "a".repeat(64), name: "shot.png", content_type: "image/png", size: 10 },
        { id: "b".repeat(64), name: "notes.txt", content_type: "application/octet-stream", size: 20 },
      ],
    }
    renderList([withFiles])
    expect(screen.getByRole("img", { name: "shot.png" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /notes\.txt/ })).toBeInTheDocument()
  })

  it("pins and unpins from the message row", async () => {
    const user = userEvent.setup()
    const pin = vi.spyOn(api, "pinMessage").mockResolvedValue({ pinned: true })
    const unpin = vi.spyOn(api, "unpinMessage").mockResolvedValue({ pinned: false })
    const first = message("01CRZ3NDEKTSV4RRFFQ69G5CC1", ada, "2026-10-18T10:00:00.000Z", "plan A")
    const second = message("01CRZ3NDEKTSV4RRFFQ69G5CC2", ada, "2026-10-18T11:00:00.000Z", "plan B")
    renderList([first, second], [], { pinned: [second.id], onOpenThread: () => undefined })
    expect(screen.getAllByText("Pinned")).toHaveLength(1)
    await user.click(screen.getByRole("button", { name: "Pin" }))
    expect(pin).toHaveBeenCalledWith(first.id)
    await user.click(screen.getByRole("button", { name: "Unpin" }))
    expect(unpin).toHaveBeenCalledWith(second.id)
  })

  it("folds a long agent answer and shows a human message whole", async () => {
    const user = userEvent.setup()
    const body = Array.from({ length: 30 }, (_, i) => `step ${i + 1}`).join("\n")
    renderList([
      message("01CRZ3NDEKTSV4RRFFQ69G5CC1", coder, "2026-10-18T10:00:00.000Z", body),
      message("01CRZ3NDEKTSV4RRFFQ69G5CC2", ada, "2026-10-18T11:00:00.000Z", body),
    ])
    const buttons = screen.getAllByRole("button", { name: /Show all/ })
    expect(buttons).toHaveLength(1)
    await user.click(buttons[0] as HTMLElement)
    expect(screen.getByRole("button", { name: "Show less" })).toBeInTheDocument()
  })

  it("puts an accent rail on a message that mentions me", () => {
    const ask = { ...message("01CRZ3NDEKTSV4RRFFQ69G5CC1", coder, "2026-10-18T10:00:00.000Z", "@ada ready?"), mentions: [ada.id] }
    const plain = message("01CRZ3NDEKTSV4RRFFQ69G5CC2", coder, "2026-10-18T11:00:00.000Z", "done")
    renderList([ask, plain])
    expect(document.getElementById(`msg-${ask.id}`)).toHaveClass("border-accent")
    expect(document.getElementById(`msg-${plain.id}`)).not.toHaveClass("border-accent")
  })

  it("explains a notice on request with the rule that fired", async () => {
    const user = userEvent.setup()
    const notice: NoticeItem = {
      id: "n1",
      channel_id: "c1",
      ts: "2026-10-18T10:00:00.000Z",
      level: "warn",
      text: "Run on kimi/default failed (403). Retrying @coder on codex/default.",
    }
    const plain: NoticeItem = { id: "n2", channel_id: "c1", ts: "2026-10-18T10:01:00.000Z", level: "info", text: "Welcome." }
    renderList([], [], { notices: [notice, plain] })
    expect(screen.getAllByRole("button", { name: "Why?" })).toHaveLength(1)
    expect(screen.queryByText(/next healthy lane/)).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Why?" }))
    expect(screen.getByText(/next healthy lane/)).toBeInTheDocument()
  })

  it("flashes the message a search result pointed at", () => {
    const first = message("01CRZ3NDEKTSV4RRFFQ69G5CC1", ada, "2026-10-18T10:00:00.000Z", "plan A")
    const second = message("01CRZ3NDEKTSV4RRFFQ69G5CC2", ada, "2026-10-18T11:00:00.000Z", "plan B")
    renderList([first, second], [], { focusId: second.id })
    expect(document.getElementById(`msg-${second.id}`)).toHaveClass("bg-accent-soft")
    expect(document.getElementById(`msg-${first.id}`)).not.toHaveClass("bg-accent-soft")
  })

  it("jumps to a new local message even when the reader scrolled up", async () => {
    const qc = renderList([message("first", ada, "2026-10-18T10:00:00Z", "first")])
    const transcript = screen.getByTestId("transcript")
    Object.defineProperties(transcript, {
      scrollHeight: { configurable: true, value: 500 },
      clientHeight: { configurable: true, value: 100 },
    })
    transcript.scrollTop = 100
    fireEvent.wheel(transcript)
    fireEvent.scroll(transcript)
    expect(screen.getByRole("button", { name: "Latest" })).toBeInTheDocument()
    act(() => qc.setQueryData<PendingMessage[]>(qk.pending("c1"), [
      { key: "new", body: "sent", createdAt: "2026-10-18T10:01:00Z" },
    ]))
    await waitFor(() => expect(transcript.scrollTop).toBe(500))
    expect(screen.queryByRole("button", { name: "Latest" })).not.toBeInTheDocument()
  })

  it("jumps on a posted own message even if no pending row was rendered", async () => {
    const first = message("first", ada, "2026-10-18T10:00:00Z", "first")
    const qc = renderList([first])
    const transcript = screen.getByTestId("transcript")
    Object.defineProperties(transcript, {
      scrollHeight: { configurable: true, value: 500 },
      clientHeight: { configurable: true, value: 100 },
    })
    transcript.scrollTop = 100
    fireEvent.wheel(transcript)
    fireEvent.scroll(transcript)
    act(() => qc.setQueryData(qk.messages("c1"), [first, message("second", ada, "2026-10-18T10:01:00Z", "sent")]))
    await waitFor(() => expect(transcript.scrollTop).toBe(500))
  })

  it("pins growing rows at the bottom but leaves a scrolled-up reader alone", () => {
    let resize: (() => void) | undefined
    class Observer {
      constructor(callback: () => void) { resize = callback }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", Observer)
    renderList([message("first", ada, "2026-10-18T10:00:00Z", "first")])
    const transcript = screen.getByTestId("transcript")
    let height = 500
    Object.defineProperties(transcript, {
      scrollHeight: { configurable: true, get: () => height },
      clientHeight: { configurable: true, value: 100 },
    })
    transcript.scrollTop = 400
    height = 600
    fireEvent.scroll(transcript)
    expect(transcript.scrollTop).toBe(600)
    act(() => resize?.())
    expect(transcript.scrollTop).toBe(600)

    fireEvent.wheel(transcript)
    transcript.scrollTop = 100
    fireEvent.scroll(transcript)
    height = 700
    act(() => resize?.())
    expect(transcript.scrollTop).toBe(100)
  })
})

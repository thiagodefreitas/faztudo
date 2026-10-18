import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { qk } from "../state/keys"
import type { Member, Message } from "../types"
import { MessageList } from "./message-list"

// jsdom has no layout, so the virtualizer would render no rows.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count, getItemKey }: { count: number; getItemKey: (index: number) => string }) => ({
    getTotalSize: () => count * 88,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, key: getItemKey(index), start: index * 88 })),
    measureElement: () => undefined,
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

function renderList(messages: Message[] = []) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  client.setQueryData(qk.messages("c1"), messages)
  client.setQueryData(qk.members, [ada, coder])
  client.setQueryData(qk.runs, [])
  client.setQueryData(qk.me, ada)
  client.setQueryData(qk.notices, [])
  client.setQueryData(qk.pending("c1"), [])
  render(
    <QueryClientProvider client={client}>
      <MessageList channelId="c1" onRetry={() => undefined} />
    </QueryClientProvider>,
  )
}

describe("MessageList", () => {
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
    expect(screen.getAllByTestId("avatar")).toHaveLength(3)
    const transcript = screen.getByTestId("transcript")
    expect(within(transcript).getAllByText("Ada")).toHaveLength(2)
    expect(within(transcript).getAllByText("Coder")).toHaveLength(1)
    expect(screen.getByText("second")).toBeInTheDocument()
  })
})

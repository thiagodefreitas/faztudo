import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { qk } from "../state/keys"
import { MessageList } from "./message-list"

function renderList() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  client.setQueryData(qk.messages("c1"), [])
  client.setQueryData(qk.members, [])
  client.setQueryData(qk.runs, [])
  client.setQueryData(qk.me, {
    id: "01ARZ3NDEKTSV4RRFFQ69G5AA1",
    kind: "human",
    handle: "ada",
    display_name: "Ada",
    presence: "online",
  })
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
})

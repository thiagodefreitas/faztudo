import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { getNotifyPrefs, reloadNotifyPrefs, setNotificationsEnabled, toggleChannelMute } from "../lib/notify-prefs"
import { emitStreamEvent } from "../state/bus"
import { qk } from "../state/keys"
import type { Channel, Member, StreamEvent } from "../types"
import { NotificationSettings, Notifier } from "./notifier"

const ada: Member = { id: "m-ada", kind: "human", handle: "ada", display_name: "Ada", presence: "online" }
const coder: Member = { id: "m-coder", kind: "agent", handle: "coder", display_name: "Coder", presence: "online" }
const dev: Channel = { id: "chan-dev", name: "dev", kind: "team", visibility: "public", member_ids: [ada.id, coder.id], unread: 3 }

class FakeNotification {
  static permission = "granted"
  static requestPermission = vi.fn(() => Promise.resolve("granted"))
  static shown: { title: string; body: string }[] = []
  onclick: (() => void) | null = null
  constructor(title: string, options: { body: string }) {
    FakeNotification.shown.push({ title, body: options.body })
  }
  close() {}
}

beforeEach(() => {
  localStorage.clear()
  reloadNotifyPrefs()
  FakeNotification.permission = "granted"
  FakeNotification.shown = []
  vi.stubGlobal("Notification", FakeNotification)
  vi.spyOn(document, "hasFocus").mockReturnValue(false)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.title = "faztudo"
})

async function mount(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(qk.members, [ada, coder])
  client.setQueryData(qk.me, ada)
  client.setQueryData(qk.channels, [dev])
  const rootRoute = createRootRoute({ component: () => node })
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory({ initialEntries: ["/"] }) })
  await router.load()
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

function mention(id: string): StreamEvent {
  return {
    seq: 1,
    id,
    version: 1,
    type: "message.posted",
    actor: "agent:m-coder",
    channel_id: dev.id,
    ts: new Date().toISOString(),
    payload: { id: "msg", channel_id: dev.id, author_id: coder.id, body: "ready for review", mentions: [ada.id], created_at: new Date().toISOString() },
  }
}

describe("Notifier", () => {
  it("shows the unread count in the tab title, leaving out muted channels", async () => {
    await mount(<Notifier />)
    await waitFor(() => expect(document.title).toBe("(3) faztudo"))
    act(() => toggleChannelMute(dev.id))
    await waitFor(() => expect(document.title).toBe("faztudo"))
  })

  it("notifies for a mention when enabled and the page is in the background", async () => {
    setNotificationsEnabled(true)
    await mount(<Notifier />)
    await waitFor(() => expect(document.title).toBe("(3) faztudo"))
    act(() => emitStreamEvent(mention("e1")))
    act(() => emitStreamEvent(mention("e1"))) // the same event twice shows once
    expect(FakeNotification.shown).toEqual([{ title: "Coder mentioned you in #dev", body: "ready for review" }])
  })

  it("stays quiet when disabled, muted, denied or in the foreground", async () => {
    await mount(<Notifier />)
    await waitFor(() => expect(document.title).toBe("(3) faztudo"))
    act(() => emitStreamEvent(mention("e1")))
    setNotificationsEnabled(true)
    act(() => toggleChannelMute(dev.id))
    act(() => emitStreamEvent(mention("e2")))
    act(() => toggleChannelMute(dev.id))
    FakeNotification.permission = "denied"
    act(() => emitStreamEvent(mention("e3")))
    FakeNotification.permission = "granted"
    vi.spyOn(document, "hasFocus").mockReturnValue(true)
    act(() => emitStreamEvent(mention("e4")))
    expect(FakeNotification.shown).toEqual([])
  })
})

describe("NotificationSettings", () => {
  it("asks for permission when switched on and remembers the choice", async () => {
    const user = userEvent.setup()
    FakeNotification.permission = "default"
    FakeNotification.requestPermission.mockImplementation(() => {
      FakeNotification.permission = "granted"
      return Promise.resolve("granted")
    })
    await mount(<NotificationSettings />)
    await user.click(await screen.findByRole("checkbox", { name: "Desktop notifications" }))
    await waitFor(() => expect(getNotifyPrefs().enabled).toBe(true))
    expect(FakeNotification.requestPermission).toHaveBeenCalled()
    expect(JSON.parse(localStorage.getItem("faztudo.notify") ?? "{}")).toMatchObject({ enabled: true })
  })

  it("stays off when permission is refused", async () => {
    const user = userEvent.setup()
    FakeNotification.permission = "default"
    FakeNotification.requestPermission.mockResolvedValue("denied")
    await mount(<NotificationSettings />)
    await user.click(await screen.findByRole("checkbox", { name: "Desktop notifications" }))
    await waitFor(() => expect(FakeNotification.requestPermission).toHaveBeenCalled())
    expect(getNotifyPrefs().enabled).toBe(false)
  })
})

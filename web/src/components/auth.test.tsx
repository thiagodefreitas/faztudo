import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiError, api } from "../api/client"
import { qk } from "../state/keys"
import type { Channel, Device, PairingTicket } from "../types"
import { DevicesPanel, LoginPage, PairPage } from "./auth"
import { ChannelSettingsDialog } from "./channel-dialogs"

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>()
  return {
    ...actual,
    useNavigate: () => vi.fn(),
  }
})

const sampleDevice: Device = {
  id: "01BRZ3NDEKTSV4RRFFQ69G5DEV",
  device_name: "Pixel 9",
  user_agent: "Mozilla/5.0 (Android 15)",
  created_at: "2026-04-17T10:00:00Z",
  last_seen_at: "2026-04-17T10:05:00Z",
  current: true,
}

const sampleChannel: Channel = {
  id: "01BRZ3NDEKTSV4RRFFQ69G5BB1",
  name: "faztudo-dev",
  kind: "team",
  visibility: "public",
  member_ids: [],
  unread: 0,
}

function wrap(node: React.ReactNode, seed?: (qc: QueryClient) => void) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  seed?.(qc)
  render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
  return qc
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("LoginPage", () => {
  it("submits password and device name", async () => {
    const user = userEvent.setup()
    const spy = vi.spyOn(api, "login").mockResolvedValue(sampleDevice)
    const onSuccess = vi.fn()
    wrap(<LoginPage onSuccess={onSuccess} />)
    await user.type(screen.getByLabelText("Password"), "synthetic-secret")
    const devInput = screen.getByLabelText("Device name")
    await user.clear(devInput)
    await user.type(devInput, "My Phone")
    await user.click(screen.getByRole("button", { name: "Sign in" }))
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(sampleDevice))
    expect(spy).toHaveBeenCalledWith({ password: "synthetic-secret", device_name: "My Phone" })
  })

  it("shows rate limit or auth errors inline", async () => {
    const user = userEvent.setup()
    vi.spyOn(api, "login").mockRejectedValue(new ApiError(429, "rate_limited", "too many failed login attempts"))
    wrap(<LoginPage />)
    await user.type(screen.getByLabelText("Password"), "wrong")
    await user.click(screen.getByRole("button", { name: "Sign in" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("too many failed login attempts")
  })
})

describe("PairPage", () => {
  it("reads the one-time token and pairs the device", async () => {
    const user = userEvent.setup()
    const spy = vi.spyOn(api, "pairDevice").mockResolvedValue(sampleDevice)
    const onSuccess = vi.fn()
    wrap(<PairPage initialToken="0123456789abcdef0123456789abcdef" onSuccess={onSuccess} />) // gitleaks:allow (synthetic test token)
    const devInput = screen.getByLabelText("Device name")
    await user.clear(devInput)
    await user.type(devInput, "Ada iPhone")
    await user.click(screen.getByRole("button", { name: "Pair device" }))
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(sampleDevice))
    expect(spy).toHaveBeenCalledWith({
      token: "0123456789abcdef0123456789abcdef", // gitleaks:allow (synthetic test token)
      device_name: "Ada iPhone",
    })
  })

  it("rejects pairing when the token is missing", async () => {
    const user = userEvent.setup()
    const spy = vi.spyOn(api, "pairDevice")
    wrap(<PairPage initialToken="" />)
    await user.click(screen.getByRole("button", { name: "Pair device" }))
    expect(await screen.findByRole("alert")).toHaveTextContent(/Pairing token is missing/i)
    expect(spy).not.toHaveBeenCalled()
  })
})

describe("DevicesPanel and Settings > Devices", () => {
  it("lists devices, revokes a device, and generates a QR code with CA fingerprint", async () => {
    const user = userEvent.setup()
    const ticket: PairingTicket = {
      token: "fedcba9876543210fedcba9876543210", // gitleaks:allow (synthetic test token)
      url: "https://192.168.1.10:7458/pair#fedcba9876543210fedcba9876543210",
      qr_svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 29 29"><rect width="29" height="29"/></svg>`,
      ca_fingerprint: "11:22:33:44:55:66:77:88",
      ca_http_url: "http://192.168.1.10:7459",
      expires_at: "2026-04-17T10:10:00Z",
    }
    vi.spyOn(api, "devices").mockResolvedValue([sampleDevice])
    vi.spyOn(api, "caInfo").mockResolvedValue({
      ca_fingerprint: "11:22:33:44:55:66:77:88",
      ca_http_url: "http://192.168.1.10:7459",
    })
    const revokeSpy = vi.spyOn(api, "revokeDevice").mockResolvedValue({ ok: true })
    const pairSpy = vi.spyOn(api, "createPairing").mockResolvedValue(ticket)

    wrap(<DevicesPanel />)
    expect(await screen.findByText("Pixel 9")).toBeInTheDocument()
    expect(screen.getByTestId("ca-fingerprint")).toHaveTextContent("11:22:33:44:55:66:77:88")

    await user.click(screen.getByRole("button", { name: "Pair a phone" }))
    await waitFor(() => expect(pairSpy).toHaveBeenCalled())
    expect(screen.getByRole("img", { name: "Pairing QR code" })).toBeInTheDocument()
    expect(screen.getByText(ticket.url)).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Revoke Pixel 9" }))
    await waitFor(() => expect(revokeSpy).toHaveBeenCalledWith(sampleDevice.id))
    await waitFor(() => expect(screen.queryByText("Pixel 9")).not.toBeInTheDocument())
  })

  it("switches to the Devices tab inside ChannelSettingsDialog", async () => {
    const user = userEvent.setup()
    vi.spyOn(api, "devices").mockResolvedValue([sampleDevice])
    vi.spyOn(api, "caInfo").mockResolvedValue({ ca_fingerprint: "AA:BB:CC" })
    wrap(<ChannelSettingsDialog channel={sampleChannel} agents={[]} open onOpenChange={() => undefined} />, (qc) => {
      qc.setQueryData(qk.channels, [sampleChannel])
    })
    await user.click(screen.getByRole("tab", { name: "Devices" }))
    expect(await screen.findByText("Pixel 9")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Pair a phone" })).toBeInTheDocument()
  })
})

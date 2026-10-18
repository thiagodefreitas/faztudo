import * as Dialog from "@radix-ui/react-dialog"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useEffect, useId, useState, type FormEvent } from "react"
import { ApiError, api } from "../api/client"
import { formatAge } from "../lib/time"
import { qk } from "../state/keys"
import { useNow } from "../state/now"
import type { Device, PairingTicket } from "../types"
import { WORKSPACE_NAME } from "../types"
import { NotificationSettings } from "./notifier"
import { WorkspaceNav } from "./sidebar"

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.message) return error.message
  if (error instanceof Error && error.message) return error.message
  return fallback
}

function defaultPhoneName(): string {
  if (typeof navigator === "undefined") return ""
  const ua = navigator.userAgent.toLowerCase()
  if (ua.includes("iphone")) return "iPhone"
  if (ua.includes("ipad")) return "iPad"
  if (ua.includes("android")) return "Android phone"
  return ""
}

export function LoginPage({ onSuccess }: { onSuccess?: (device: Device) => void }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const passwordId = useId()
  const deviceId = useId()
  const [password, setPassword] = useState("")
  const [deviceName, setDeviceName] = useState(() => defaultPhoneName())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    if (!password) {
      setError("Password is required")
      return
    }
    setBusy(true)
    setError(null)
    const trimmedDevice = deviceName.trim()
    void api
      .login({
        password,
        ...(trimmedDevice ? { device_name: trimmedDevice } : {}),
      })
      .then(
        async (device) => {
          setBusy(false)
          await qc.invalidateQueries()
          if (onSuccess) onSuccess(device)
          else void navigate({ to: "/" })
        },
        (err: unknown) => {
          setBusy(false)
          setError(errorMessage(err, "Sign in failed"))
        },
      )
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-canvas p-4 text-ink">
      <div className="w-full max-w-sm rounded-md border border-line bg-surface p-5 shadow-sm">
        <p className="font-mono text-[12px] text-muted">{WORKSPACE_NAME}</p>
        <h1 className="mt-1 text-[18px] font-semibold">Sign in</h1>
        <p className="mt-1 text-[13px] text-muted">Enter the local password set with faztudo passwd.</p>
        <form className="mt-4 flex flex-col gap-3" onSubmit={submit} noValidate>
          <div>
            <label htmlFor={passwordId} className="block text-[13px] font-medium">
              Password
            </label>
            <input
              id={passwordId}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="mt-1 min-h-11 w-full rounded-md border border-line bg-canvas px-3 text-[16px] text-ink md:min-h-9 md:text-[14px]"
            />
          </div>
          <div>
            <label htmlFor={deviceId} className="block text-[13px] font-medium">
              Device name
            </label>
            <input
              id={deviceId}
              type="text"
              value={deviceName}
              onChange={(event) => setDeviceName(event.target.value)}
              placeholder="Phone or laptop"
              className="mt-1 min-h-11 w-full rounded-md border border-line bg-canvas px-3 text-[16px] text-ink md:min-h-9 md:text-[14px]"
            />
          </div>
          {error && (
            <p role="alert" className="text-[12px] text-danger">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={busy}
            className="mt-1 min-h-11 rounded-md bg-accent px-4 text-[14px] font-medium text-canvas disabled:opacity-60 md:min-h-9 md:text-[13px]"
          >
            {busy ? "Signing in..." : "Sign in"}
          </button>
        </form>
      </div>
    </main>
  )
}

export function PairPage({
  initialToken,
  onSuccess,
}: {
  initialToken?: string
  onSuccess?: (device: Device) => void
}) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const deviceId = useId()
  const [token, setToken] = useState(() => {
    if (initialToken !== undefined) return initialToken
    if (typeof window === "undefined") return ""
    return window.location.hash.replace(/^#/, "").trim()
  })
  const [deviceName, setDeviceName] = useState(() => defaultPhoneName() || "Phone")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (initialToken !== undefined || typeof window === "undefined") return
    function onHashChange() {
      setToken(window.location.hash.replace(/^#/, "").trim())
    }
    window.addEventListener("hashchange", onHashChange)
    return () => window.removeEventListener("hashchange", onHashChange)
  }, [initialToken])

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    const trimmedToken = token.trim()
    const trimmedName = deviceName.trim()
    if (!trimmedToken) {
      setError("Pairing token is missing from the link. Scan a fresh QR code from your desktop.")
      return
    }
    if (!trimmedName) {
      setError("Device name is required")
      return
    }
    setBusy(true)
    setError(null)
    void api
      .pairDevice({
        token: trimmedToken,
        device_name: trimmedName,
      })
      .then(
        async (device) => {
          setBusy(false)
          if (typeof window !== "undefined" && window.location.hash) {
            window.history.replaceState(null, "", window.location.pathname)
          }
          await qc.invalidateQueries()
          if (onSuccess) onSuccess(device)
          else void navigate({ to: "/" })
        },
        (err: unknown) => {
          setBusy(false)
          setError(errorMessage(err, "Pairing failed"))
        },
      )
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-canvas p-4 text-ink">
      <div className="w-full max-w-sm rounded-md border border-line bg-surface p-5 shadow-sm">
        <p className="font-mono text-[12px] text-muted">{WORKSPACE_NAME}</p>
        <h1 className="mt-1 text-[18px] font-semibold">Pair this device</h1>
        <p className="mt-1 text-[13px] text-muted">
          Name this phone or tablet so you can recognize and revoke it later from Settings &gt; Devices.
        </p>
        <form className="mt-4 flex flex-col gap-3" onSubmit={submit} noValidate>
          <div>
            <label htmlFor={deviceId} className="block text-[13px] font-medium">
              Device name
            </label>
            <input
              id={deviceId}
              type="text"
              value={deviceName}
              onChange={(event) => setDeviceName(event.target.value)}
              placeholder="My phone"
              className="mt-1 min-h-11 w-full rounded-md border border-line bg-canvas px-3 text-[16px] text-ink md:min-h-9 md:text-[14px]"
            />
          </div>
          {error && (
            <p role="alert" className="text-[12px] text-danger">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={busy}
            className="mt-1 min-h-11 rounded-md bg-accent px-4 text-[14px] font-medium text-canvas disabled:opacity-60 md:min-h-9 md:text-[13px]"
          >
            {busy ? "Pairing..." : "Pair device"}
          </button>
        </form>
      </div>
    </main>
  )
}

export function DevicesPanel() {
  const qc = useQueryClient()
  const now = useNow()
  const devices = useQuery({
    queryKey: qk.devices,
    queryFn: () => api.devices(),
  })
  const caInfo = useQuery({
    queryKey: qk.caInfo,
    queryFn: () => api.caInfo(),
  })
  const [pairing, setPairing] = useState<PairingTicket | null>(null)
  const [pairingBusy, setPairingBusy] = useState(false)
  const [revokingId, setRevokingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  function startPairing() {
    if (pairingBusy) return
    setPairingBusy(true)
    setError(null)
    void api.createPairing().then(
      (ticket) => {
        setPairingBusy(false)
        setPairing(ticket)
      },
      (err: unknown) => {
        setPairingBusy(false)
        setError(errorMessage(err, "Could not create pairing code"))
      },
    )
  }

  function revoke(id: string) {
    if (revokingId) return
    setRevokingId(id)
    setError(null)
    void api.revokeDevice(id).then(
      () => {
        setRevokingId(null)
        qc.setQueryData<Device[]>(qk.devices, (list = []) => list.filter((item) => item.id !== id))
      },
      (err: unknown) => {
        setRevokingId(null)
        setError(errorMessage(err, "Could not revoke device"))
      },
    )
  }

  const fingerprint = pairing?.ca_fingerprint || caInfo.data?.ca_fingerprint || ""
  const caHelperUrl = pairing?.ca_http_url || caInfo.data?.ca_http_url || ""
  const list = devices.data ?? []

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-[14px] font-semibold">Paired devices</h2>
          <p className="text-[12px] text-muted">Active LAN sessions. Revoking a device disconnects it immediately.</p>
        </div>
        <button
          type="button"
          onClick={startPairing}
          disabled={pairingBusy}
          className="min-h-9 rounded-md bg-accent px-3 text-[13px] font-medium text-canvas disabled:opacity-60"
        >
          {pairingBusy ? "Generating..." : "Pair a phone"}
        </button>
      </div>

      {error && (
        <p role="alert" className="text-[12px] text-danger">
          {error}
        </p>
      )}

      {fingerprint && (
        <div className="rounded-md border border-line bg-canvas p-3">
          <p className="text-[12px] font-medium">Local CA SHA-256 fingerprint</p>
          <p className="mt-0.5 text-[12px] text-muted">
            Compare this fingerprint when installing the local CA certificate on your phone
            {caHelperUrl ? ` from ${caHelperUrl}` : ""}:
          </p>
          <p data-testid="ca-fingerprint" className="mt-1.5 break-all font-mono text-[12px] text-ink">
            {fingerprint}
          </p>
        </div>
      )}

      {pairing && (
        <div className="rounded-md border border-line bg-canvas p-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
            <div
              role="img"
              aria-label="Pairing QR code"
              className="h-44 w-44 shrink-0 overflow-hidden rounded border border-line bg-surface p-2 [&>svg]:h-full [&>svg]:w-full"
              dangerouslySetInnerHTML={{ __html: pairing.qr_svg }}
            />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium">Scan with your phone camera</p>
              <p className="mt-1 text-[12px] text-muted">
                This one-time link expires in 5 minutes and works once. First install the local CA certificate on your
                phone, verify the SHA-256 fingerprint above, then open:
              </p>
              <p className="mt-2 break-all rounded border border-line bg-surface px-2 py-1 font-mono text-[12px]">
                {pairing.url}
              </p>
            </div>
          </div>
        </div>
      )}

      {devices.isPending ? (
        <p className="text-[13px] text-muted">Loading devices</p>
      ) : list.length === 0 ? (
        <p className="text-[13px] text-muted">No paired devices yet.</p>
      ) : (
        <ul aria-label="Paired devices" className="flex flex-col divide-y divide-line rounded-md border border-line bg-canvas">
          {list.map((device) => (
            <li key={device.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="truncate text-[13px] font-medium">{device.device_name}</p>
                  {device.current && (
                    <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-ink">
                      This device
                    </span>
                  )}
                </div>
                <p className="mt-0.5 truncate font-mono text-[11px] text-muted">
                  Last seen {formatAge(device.last_seen_at, now)}
                  {device.user_agent ? `, ${device.user_agent}` : ""}
                </p>
              </div>
              <button
                type="button"
                onClick={() => revoke(device.id)}
                disabled={revokingId === device.id}
                aria-label={`Revoke ${device.device_name}`}
                className="min-h-9 rounded-md border border-danger px-3 text-[12px] text-danger disabled:opacity-60"
              >
                {revokingId === device.id ? "Revoking..." : "Revoke"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function DevicesPage() {
  const [navOpen, setNavOpen] = useState(false)
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b border-line px-3 py-2">
        <Dialog.Root open={navOpen} onOpenChange={setNavOpen}>
          <Dialog.Trigger className="min-h-9 rounded border border-line px-2.5 text-[12px] md:hidden">
            Channels
          </Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/40" />
            <Dialog.Content className="fixed inset-y-0 left-0 z-50 flex w-72 flex-col bg-sidebar p-2 shadow-lg">
              <Dialog.Title className="px-2 pt-2 text-[13px] font-medium">Channels</Dialog.Title>
              <WorkspaceNav onNavigate={() => setNavOpen(false)} />
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
        <h1 className="text-[15px] font-semibold">Settings &gt; Devices</h1>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="max-w-2xl">
          <DevicesPanel />
        </div>
        <NotificationSettings />
      </div>
    </section>
  )
}

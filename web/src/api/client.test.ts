import { describe, expect, it } from "vitest"
import { ApiError, createApi } from "./client"

interface Call {
  url: string
  method: string
  body?: unknown
  credentials?: RequestCredentials
}

function fakeFetch(status = 200, payload: unknown = {}) {
  const calls: Call[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined
    calls.push({ url: String(input), method: init?.method ?? "GET", body, credentials: init?.credentials })
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } })
  }
  return { fetchImpl, calls }
}

describe("api client", () => {
  it("calls the documented paths", async () => {
    const { fetchImpl, calls } = fakeFetch()
    const api = createApi({ fetch: fetchImpl })
    await api.me()
    await api.messages("ch-1", { before: "m-1", limit: 10 })
    await api.postMessage("ch-1", { body: "hi @coder", idempotency_key: "key-1" })
    await api.runs({ channel_id: "ch-1", state: "running" })
    await api.output("run-1", 4)
    await api.diff("run-1")
    await api.retryRun("run-1", { lane_id: "claude/opus" })
    await api.approvals("pending")
    await api.resolveApproval("ap-1", { option: "push" })
    await api.patchLane("codex/default", { capacity: 2 })
    await api.probeLane("codex/default")
    await api.markRead("ch-1", { seq: 7 })

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET /api/v1/me",
      "GET /api/v1/channels/ch-1/messages?before=m-1&limit=10",
      "POST /api/v1/channels/ch-1/messages",
      "GET /api/v1/runs?channel_id=ch-1&state=running",
      "GET /api/v1/runs/run-1/output?after=4",
      "GET /api/v1/runs/run-1/diff",
      "POST /api/v1/runs/run-1/retry",
      "GET /api/v1/approvals?state=pending",
      "POST /api/v1/approvals/ap-1/resolve",
      "PATCH /api/v1/lanes/codex%2Fdefault",
      "POST /api/v1/lanes/codex%2Fdefault/probe",
      "POST /api/v1/channels/ch-1/read",
    ])
    expect(calls[2]?.body).toEqual({ body: "hi @coder", idempotency_key: "key-1" })
    expect(calls.every((call) => call.credentials === "same-origin")).toBe(true)
    expect(calls[6]?.body).toEqual({ lane_id: "claude/opus" })
  })

  it("reads the error envelope", async () => {
    const { fetchImpl } = fakeFetch(404, { error: { code: "not_found", message: "channel not found" } })
    const api = createApi({ fetch: fetchImpl })
    await expect(api.me()).rejects.toMatchObject({
      name: "ApiError",
      status: 404,
      code: "not_found",
      message: "channel not found",
    } satisfies Partial<ApiError>)
  })

  it("calls the auth and pairing endpoints", async () => {
    const { fetchImpl, calls } = fakeFetch()
    const api = createApi({ fetch: fetchImpl })
    await api.login({ password: "synthetic-password", device_name: "Pixel" })
    await api.logout()
    await api.devices()
    await api.revokeDevice("dev-1")
    await api.createPairing()
    await api.pairDevice({ token: "0123456789abcdef0123456789abcdef", device_name: "Phone" }) // gitleaks:allow (synthetic test token)
    await api.caInfo()

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "POST /api/v1/auth/login",
      "POST /api/v1/auth/logout",
      "GET /api/v1/auth/devices",
      "DELETE /api/v1/auth/devices/dev-1",
      "POST /api/v1/auth/pairings",
      "POST /api/v1/auth/pair",
      "GET /api/v1/auth/ca",
    ])
    expect(calls[0]?.body).toEqual({ password: "synthetic-password", device_name: "Pixel" })
    expect(calls[5]?.body).toEqual({ token: "0123456789abcdef0123456789abcdef", device_name: "Phone" }) // gitleaks:allow (synthetic test token)
  })
})


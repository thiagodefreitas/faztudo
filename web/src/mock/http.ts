import type { ApprovalState, RunState } from "../types"
import type { Result } from "./result"
import { err } from "./result"
import type { MockWorld } from "./world"

export interface MockResponse {
  status: number
  body: unknown
}

function send<T>(result: Result<T>): MockResponse {
  if (!result.ok) return { status: result.status, body: { error: { code: result.code, message: result.message } } }
  return { status: result.status, body: result.data }
}

function jsonBody(raw: string): Result<unknown> {
  if (!raw.trim()) return { ok: true, status: 200, data: {} }
  try {
    return { ok: true, status: 200, data: JSON.parse(raw) as unknown }
  } catch {
    return err(400, "bad_request", "invalid json")
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function num(value: string | null): number | undefined {
  if (value === null || value === "") return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

// Maps the docs/api.md routes onto the in-memory world. Lane ids may contain
// a slash, so each path segment is decoded.
export function handleMock(world: MockWorld, method: string, url: URL, rawBody = ""): MockResponse {
  const path = url.pathname.replace(/\/+$/, "") || "/"
  if (!path.startsWith("/api/v1")) return { status: 404, body: { error: { code: "not_found", message: "not found" } } }
  const parts = path
    .slice("/api/v1".length)
    .split("/")
    .filter(Boolean)
    .map((part) => decodeURIComponent(part))

  if (method === "GET" && parts.length === 1 && parts[0] === "health") return { status: 200, body: world.health() }
  if (method === "GET" && parts[0] === "me" && parts.length === 1) return { status: 200, body: world.getMe() }
  if (method === "GET" && parts[0] === "members" && parts.length === 1) return { status: 200, body: world.getMembers() }
  if (method === "GET" && parts[0] === "channels" && parts.length === 1) return { status: 200, body: world.getChannels() }
  if (method === "GET" && parts[0] === "lanes" && parts.length === 1) return { status: 200, body: world.getLanes() }
  if (method === "GET" && parts[0] === "lanes" && parts[1] === "channel-summary" && parts.length === 3) {
    return { status: 200, body: { channel_id: parts[2] ?? "", text: "" } }
  }
  if (method === "GET" && parts[0] === "org" && parts.length === 1) return { status: 200, body: world.getOrg() }
  if (method === "GET" && parts[0] === "routines" && parts.length === 1) return { status: 200, body: world.getRoutines() }

  if (method === "GET" && parts[0] === "search" && parts.length === 1) {
    return send(world.search(url.searchParams.get("q") ?? "", url.searchParams.get("channel_id") ?? undefined))
  }
  if (method === "GET" && parts[0] === "channels" && parts[2] === "pins" && parts.length === 3) {
    return send(world.getPins(parts[1] ?? ""))
  }
  if (parts[0] === "messages" && parts[2] === "pin" && parts.length === 3 && (method === "POST" || method === "DELETE")) {
    return send(world.setPin(parts[1] ?? "", method === "POST"))
  }
  if (parts[0] === "files" && method === "POST") {
    return send(err(503, "unavailable", "file uploads are not available in the mock"))
  }

  const parsed = jsonBody(rawBody)
  if (!parsed.ok) return send(parsed)
  const body = asRecord(parsed.data)

  if (parts[0] === "channels" && parts.length === 1 && method === "POST") {
    const name = text(body.name)
    const kind = text(body.kind)
    const visibility = text(body.visibility)
    if (!name || !kind || !visibility) return send(err(400, "bad_request", "name, kind, and visibility are required"))
    return send(
      world.createChannel({
        name,
        kind: kind as "team",
        visibility: visibility as "public",
        ...(text(body.topic) ? { topic: text(body.topic) } : {}),
        ...(text(body.repo_path) ? { repo_path: text(body.repo_path) } : {}),
        ...(Array.isArray(body.member_ids) ? { member_ids: body.member_ids.filter((id): id is string => typeof id === "string") } : {}),
      }),
    )
  }

  if (parts[0] === "channels" && parts.length === 2 && method === "PATCH") {
    const id = parts[1]
    if (!id) return send(err(404, "not_found", "channel not found"))
    return send(
      world.patchChannel(id, {
        ...(text(body.name) ? { name: text(body.name) } : {}),
        ...(body.topic !== undefined && typeof body.topic === "string" ? { topic: body.topic } : {}),
        ...(body.repo_path !== undefined && typeof body.repo_path === "string" ? { repo_path: body.repo_path } : {}),
        ...(typeof body.test_command === "string" ? { test_command: body.test_command } : {}),
        ...(typeof body.default_agent_id === "string" ? { default_agent_id: body.default_agent_id } : {}),
        ...(Array.isArray(body.member_ids) ? { member_ids: body.member_ids.filter((item): item is string => typeof item === "string") } : {}),
      }),
    )
  }

  if (parts[0] === "channels" && parts[2] === "messages" && parts.length === 3) {
    const id = parts[1]
    if (!id) return send(err(404, "not_found", "channel not found"))
    if (method === "GET") {
      const before = url.searchParams.get("before") ?? undefined
      const limit = num(url.searchParams.get("limit"))
      return send(world.getMessages(id, before, limit))
    }
    if (method === "POST") {
      const message = text(body.body)
      if (message === undefined) return send(err(400, "bad_request", "body is required"))
      return send(
        world.postMessage(id, {
          body: message,
          ...(text(body.thread_id) ? { thread_id: text(body.thread_id) } : {}),
          ...(text(body.idempotency_key) ? { idempotency_key: text(body.idempotency_key) } : {}),
        }),
      )
    }
  }

  if (parts[0] === "channels" && parts[2] === "read" && parts.length === 3 && method === "POST") {
    const id = parts[1]
    if (!id) return send(err(404, "not_found", "channel not found"))
    return send(world.markRead(id, { seq: typeof body.seq === "number" ? body.seq : 0 }))
  }

  if (parts[0] === "messages" && parts[2] === "thread" && parts.length === 3 && method === "GET") {
    const id = parts[1]
    if (!id) return send(err(404, "not_found", "message not found"))
    return send(world.getThread(id))
  }

  if (parts[0] === "runs" && parts.length === 1 && method === "GET") {
    return send(world.getRuns(url.searchParams.get("channel_id") ?? undefined, (url.searchParams.get("state") as RunState | null) ?? undefined))
  }

  if (parts[0] === "runs" && parts.length === 2 && method === "GET") {
    const id = parts[1]
    if (!id) return send(err(404, "not_found", "run not found"))
    return send(world.getRun(id))
  }

  if (parts[0] === "runs" && parts[2] === "output" && method === "GET") {
    const id = parts[1]
    if (!id) return send(err(404, "not_found", "run not found"))
    return send(world.getOutput(id, num(url.searchParams.get("after")) ?? 0))
  }

  if (parts[0] === "runs" && parts[2] === "diff" && method === "GET") {
    const id = parts[1]
    if (!id) return send(err(404, "not_found", "run not found"))
    return send(world.getDiff(id))
  }

  if (parts[0] === "runs" && parts[2] === "cancel" && method === "POST") {
    const id = parts[1]
    if (!id) return send(err(404, "not_found", "run not found"))
    return send(world.cancelRun(id))
  }

  if (parts[0] === "runs" && parts[2] === "retry" && method === "POST") {
    const id = parts[1]
    if (!id) return send(err(404, "not_found", "run not found"))
    return send(world.retryRun(id, text(body.lane_id) ? { lane_id: text(body.lane_id) } : {}))
  }

  if (parts[0] === "approvals" && parts.length === 1 && method === "GET") {
    const state = url.searchParams.get("state") as ApprovalState | null
    return { status: 200, body: world.getApprovals(state ?? undefined) }
  }

  if (parts[0] === "approvals" && parts[2] === "resolve" && method === "POST") {
    const id = parts[1]
    const option = text(body.option)
    if (!id) return send(err(404, "not_found", "approval not found"))
    if (!option) return send(err(400, "bad_request", "option is required"))
    return send(world.resolveApproval(id, { option, ...(text(body.note) ? { note: text(body.note) } : {}) }))
  }

  if (parts[0] === "lanes" && parts.length === 2 && method === "PATCH") {
    const id = parts[1]
    if (!id) return send(err(404, "not_found", "lane not found"))
    const health = text(body.health_override)
    const manual = asRecord(body.manual_window)
    return send(
      world.patchLane(id, {
        ...(typeof body.capacity === "number" ? { capacity: body.capacity } : {}),
        ...(health ? { health_override: health as "available" } : {}),
        ...(text(manual.name)
          ? {
              manual_window: {
                name: text(manual.name) as "5h",
                ...(typeof manual.used_pct === "number" ? { used_pct: manual.used_pct } : {}),
                ...(text(manual.resets_at) ? { resets_at: text(manual.resets_at) } : {}),
              },
            }
          : {}),
      }),
    )
  }

  if (parts[0] === "lanes" && parts[2] === "probe" && method === "POST") {
    const id = parts[1]
    if (!id) return send(err(404, "not_found", "lane not found"))
    return send(world.probeLane(id))
  }

  if (parts[0] === "routines" && parts[1]) {
    if (parts.length === 2 && method === "PATCH") {
      if (typeof body.enabled !== "boolean") return send(err(400, "bad_request", "enabled required"))
      return send(world.setRoutineEnabled(parts[1], body.enabled))
    }
    if (parts.length === 3 && parts[2] === "run" && method === "POST") return send(world.runRoutine(parts[1]))
  }

  if (parts[0] === "projects" && parts[2] === "assignments") {
    const project = parts[1]
    if (!project) return send(err(404, "not_found", "resource not found"))
    if (method === "POST" && parts.length === 3) {
      const kind = text(body.kind)
      const handle = text(body.handle)
      if ((kind !== "department" && kind !== "specialist") || !handle) {
        return send(err(400, "bad_request", "kind must be department or specialist"))
      }
      return send(world.assign(project, { kind, handle }))
    }
    if (method === "DELETE" && parts.length === 5) {
      const kind = parts[3]
      const handle = parts[4]
      if ((kind !== "department" && kind !== "specialist") || !handle) {
        return send(err(400, "bad_request", "kind must be department or specialist"))
      }
      return send(world.unassign(project, kind, handle))
    }
  }

  if (parts[0] === "auth") {
    if (parts[1] === "login" && parts.length === 2 && method === "POST") {
      return send(world.login({ password: text(body.password) ?? "", ...(text(body.device_name) ? { device_name: text(body.device_name) } : {}) }))
    }
    if (parts[1] === "logout" && parts.length === 2 && method === "POST") {
      return send(world.logout())
    }
    if (parts[1] === "devices" && parts.length === 2 && method === "GET") {
      return { status: 200, body: world.getDevices() }
    }
    if (parts[1] === "devices" && parts.length === 3 && method === "DELETE") {
      const id = parts[2]
      if (!id) return send(err(404, "not_found", "device not found"))
      return send(world.revokeDevice(id))
    }
    if (parts[1] === "pairings" && parts.length === 2 && method === "POST") {
      return send(world.createPairing())
    }
    if (parts[1] === "pair" && parts.length === 2 && method === "POST") {
      return send(world.pairDevice({ token: text(body.token) ?? "", device_name: text(body.device_name) ?? "" }))
    }
    if (parts[1] === "ca" && parts.length === 2 && method === "GET") {
      return { status: 200, body: world.caInfo() }
    }
  }

  return { status: 404, body: { error: { code: "not_found", message: "not found" } } }
}


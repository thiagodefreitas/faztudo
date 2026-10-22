import type { Lane, Member } from "../types"
import { formatCountdown } from "./lane-format"

const LOGIN = /auth|login|log in|sign in|credential|unauthori[sz]ed|api key|\b401\b|\b403\b/i

/** The lane that would take over from this one: the next usable lane in the first persona chain that lists it. */
export function takeoverLane(lane: Lane, lanes: Lane[], members: Member[]): string | undefined {
  const byId = new Map(lanes.map((item) => [item.id, item]))
  for (const member of members) {
    const chain = member.agent?.lanes ?? []
    if (!chain.includes(lane.id)) continue
    const next = chain.find((id) => id !== lane.id && (byId.get(id)?.health === "available" || byId.get(id)?.health === "conserve"))
    if (next) return next
  }
  return undefined
}

/** One next-step line for a lane error, or undefined when nothing useful can be said. */
export function laneAdvice(lane: Lane, lanes: Lane[], members: Member[], now: number): string | undefined {
  const error = lane.last_error
  if (!error && lane.health !== "exhausted") return undefined
  const text = `${error?.class ?? ""} ${error?.message ?? ""}`
  if (lane.health === "exhausted" || error?.class === "exhausted") {
    const reset = lane.windows.map((window) => window.resets_at).find((at) => at && Date.parse(at) > now)
    const when = reset ? formatCountdown(reset, now) : "reset time unknown"
    const next = takeoverLane(lane, lanes, members)
    return `Out of quota (${when}).${next ? ` Work moves to ${next} until then.` : ""}`
  }
  if (LOGIN.test(text)) return `Run "${lane.cli} login" in a terminal, then press Probe now.`
  if (lane.health === "unavailable" || error?.class === "unavailable") {
    return `Check that the ${lane.cli} CLI is installed and on PATH ("faztudo doctor"), then press Probe now.`
  }
  if (error?.class === "transient") return "Probably temporary. The lane retries on its own; press Probe now to check sooner."
  return 'Run "faztudo doctor" in a terminal to see what is wrong, then press Probe now.'
}

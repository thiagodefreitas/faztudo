import { ORBIT_PITCH_STEP, ORBIT_YAW_STEP, ZOOM_STEP } from "./camera"

export type OfficeKeyAction =
  | { type: "orbit"; yaw: number; pitch: number }
  | { type: "zoom"; radiusDelta: number }
  | { type: "cycle"; delta: 1 | -1 }
  | { type: "reset" }

export interface OfficeKeyInput {
  key: string
  shiftKey?: boolean
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
}

// Arrow keys orbit, +/- zoom, Tab cycles desks, Escape returns to the overview.
// Modifier chords are left to the browser.
export function mapOfficeKey(input: OfficeKeyInput): OfficeKeyAction | null {
  if (input.metaKey || input.ctrlKey || input.altKey) return null
  switch (input.key) {
    case "ArrowLeft":
      return { type: "orbit", yaw: -ORBIT_YAW_STEP, pitch: 0 }
    case "ArrowRight":
      return { type: "orbit", yaw: ORBIT_YAW_STEP, pitch: 0 }
    case "ArrowUp":
      return { type: "orbit", yaw: 0, pitch: -ORBIT_PITCH_STEP }
    case "ArrowDown":
      return { type: "orbit", yaw: 0, pitch: ORBIT_PITCH_STEP }
    case "+":
    case "=":
    case "NumpadAdd":
      return { type: "zoom", radiusDelta: -ZOOM_STEP }
    case "-":
    case "_":
    case "NumpadSubtract":
      return { type: "zoom", radiusDelta: ZOOM_STEP }
    case "Tab":
      return { type: "cycle", delta: input.shiftKey ? -1 : 1 }
    case "Escape":
      return { type: "reset" }
    default:
      return null
  }
}

export function cycleDeskIndex(count: number, current: number, delta: 1 | -1): number {
  if (count <= 0) return -1
  const start = current < 0 || current >= count ? (delta > 0 ? -1 : 0) : current
  return (start + delta + count) % count
}

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return Boolean(target.closest("input, textarea, select"))
}

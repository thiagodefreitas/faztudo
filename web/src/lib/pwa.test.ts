import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { activateUpdate, dismissInstallHint, installHintVisible, isPhone, updateAvailable } from "./pwa"

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })))
})

afterEach(() => vi.unstubAllGlobals())

describe("install hint", () => {
  it("appears on phones and stays dismissed", () => {
    expect(isPhone("Mozilla/5.0 (iPhone)")).toBe(true)
    expect(installHintVisible("Mozilla/5.0 (iPhone)")).toBe(true)
    dismissInstallHint()
    expect(installHintVisible("Mozilla/5.0 (iPhone)")).toBe(false)
    expect(localStorage.getItem("faztudo.pwa.install-dismissed")).toBe("1")
  })

  it("stays hidden on desktop and in standalone mode", () => {
    expect(installHintVisible("Mozilla/5.0 (X11; Linux x86_64)")).toBe(false)
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })))
    expect(installHintVisible("Mozilla/5.0 (Android)")).toBe(false)
  })
})

describe("updates", () => {
  it("only offers reload for a waiting worker after an active worker", () => {
    const waiting = { postMessage: vi.fn() }
    const events = new EventTarget()
    const serviceWorker = Object.assign(events, { controller: null as ServiceWorker | null })
    vi.stubGlobal("navigator", { serviceWorker })
    const registration = { waiting } as unknown as ServiceWorkerRegistration
    expect(updateAvailable(registration)).toBe(false)
    serviceWorker.controller = {} as ServiceWorker
    expect(updateAvailable(registration)).toBe(true)
    activateUpdate(registration)
    expect(waiting.postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" })
  })
})

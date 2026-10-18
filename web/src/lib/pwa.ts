const INSTALL_DISMISSED_KEY = "faztudo.pwa.install-dismissed"

export interface InstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>
}

export function isPhone(userAgent: string): boolean {
  return /Android|iPhone|iPod/i.test(userAgent)
}

export function isStandalone(): boolean {
  return (typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches) ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
}

export function installHintVisible(userAgent: string): boolean {
  if (!isPhone(userAgent) || isStandalone()) return false
  try {
    return localStorage.getItem(INSTALL_DISMISSED_KEY) !== "1"
  } catch {
    return true
  }
}

export function dismissInstallHint(): void {
  try {
    localStorage.setItem(INSTALL_DISMISSED_KEY, "1")
  } catch {
    // Storage may be disabled; dismiss the hint for this page regardless.
  }
}

export function updateAvailable(registration: ServiceWorkerRegistration): boolean {
  return registration.waiting !== null && navigator.serviceWorker.controller !== null
}

export function activateUpdate(registration: ServiceWorkerRegistration): void {
  const waiting = registration.waiting
  if (!waiting) return
  navigator.serviceWorker.addEventListener("controllerchange", () => window.location.reload(), { once: true })
  waiting.postMessage({ type: "SKIP_WAITING" })
}

import { useEffect, useState } from "react"
import { cx } from "../lib/cx"
import { activateUpdate, dismissInstallHint, installHintVisible, type InstallPromptEvent, updateAvailable } from "../lib/pwa"

declare const __FAZTUDO_BUILD_ID__: string

const BAR = "flex items-center justify-between gap-3 border-t border-line bg-surface px-4 py-2 text-[13px] shadow-sm"
const PRIMARY = "min-h-9 rounded-md bg-accent px-3 py-1.5 font-medium text-white transition-opacity hover:opacity-90 dark:text-canvas"

export function PwaStatus() {
  const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null)
  const [showUpdate, setShowUpdate] = useState(false)
  const [showInstall, setShowInstall] = useState(() => installHintVisible(navigator.userAgent))
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null)

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return
    let mounted = true
    let current: ServiceWorkerRegistration | null = null
    let installing: ServiceWorker | null = null
    const check = () => {
      if (mounted && current) setShowUpdate(updateAvailable(current))
    }
    const onStateChange = () => {
      if (installing?.state === "installed") window.setTimeout(check, 0)
    }
    const onUpdateFound = () => {
      installing?.removeEventListener("statechange", onStateChange)
      installing = current?.installing ?? null
      installing?.addEventListener("statechange", onStateChange)
    }
    void navigator.serviceWorker.register(`/sw.js?v=${__FAZTUDO_BUILD_ID__}`, { scope: "/" }).then((value) => {
      if (!mounted) return
      current = value
      setRegistration(value)
      value.addEventListener("updatefound", onUpdateFound)
      check()
    }).catch(() => {
      // The app remains usable if service workers are unavailable.
    })
    return () => {
      mounted = false
      current?.removeEventListener("updatefound", onUpdateFound)
      installing?.removeEventListener("statechange", onStateChange)
    }
  }, [])

  useEffect(() => {
    const onBeforeInstall = (event: Event) => {
      event.preventDefault()
      setInstallPrompt(event as InstallPromptEvent)
    }
    const onInstalled = () => {
      dismissInstallHint()
      setShowInstall(false)
      setInstallPrompt(null)
    }
    window.addEventListener("beforeinstallprompt", onBeforeInstall)
    window.addEventListener("appinstalled", onInstalled)
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall)
      window.removeEventListener("appinstalled", onInstalled)
    }
  }, [])

  if (showUpdate && registration) {
    return (
      <div role="status" className={BAR}>
        <span className="flex items-center gap-2">
          <span className="h-2 w-2 shrink-0 rounded-full bg-accent" aria-hidden="true" />
          New version available
        </span>
        <button type="button" className={PRIMARY} onClick={() => activateUpdate(registration)}>
          Reload
        </button>
      </div>
    )
  }

  if (!showInstall) return null
  return (
    <div role="status" className={cx(BAR, "md:hidden")}>
      <span>Install faztudo for quick access. {installPrompt ? "" : "Use your browser's Add to Home Screen menu."}</span>
      <div className="flex shrink-0 gap-2">
        {installPrompt && <button type="button" className={PRIMARY} onClick={() => {
          void installPrompt.prompt().then(() => installPrompt.userChoice).then(() => {
            dismissInstallHint()
            setShowInstall(false)
            setInstallPrompt(null)
          })
        }}>Install</button>}
        <button type="button" aria-label="Dismiss install hint" className="min-h-9 rounded-md px-2 py-1.5 text-muted transition-colors hover:bg-canvas hover:text-ink" onClick={() => {
          dismissInstallHint()
          setShowInstall(false)
        }}>Dismiss</button>
      </div>
    </div>
  )
}

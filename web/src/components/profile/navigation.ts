import { useRouter } from "@tanstack/react-router"
import { useCallback, useSyncExternalStore } from "react"

// The profile sheet lives in the URL as ?profile=<handle> on any route, so the
// palette, Today and a pasted link can all open it. The element that opened
// it gets focus back when the sheet closes.
let opener: HTMLElement | null = null
const CHANGE = "faztudo:profile-change"

export function profileOpener(): HTMLElement | null {
  return opener
}

export function profileFromSearch(search: string): string | undefined {
  const raw = new URLSearchParams(search).get("profile")?.trim()
  // The router writes search values as JSON, so a handle may arrive quoted.
  const handle = raw?.replace(/^"(.*)"$/, "$1").replace(/^@/, "")
  return handle || undefined
}

type History = ReturnType<typeof useRouter>["history"] | undefined

function windowSubscribe(listener: () => void): () => void {
  window.addEventListener(CHANGE, listener)
  window.addEventListener("popstate", listener)
  return () => {
    window.removeEventListener(CHANGE, listener)
    window.removeEventListener("popstate", listener)
  }
}

// The router's history when there is one, so the router sees every change;
// the window's otherwise (a component rendered on its own in a test).
function currentSearch(history: History): string {
  return history ? history.location.search : window.location.search
}

export function useProfileNavigation() {
  // Optional: a few components also render outside a RouterProvider.
  const router = useRouter({ warn: false }) as ReturnType<typeof useRouter> | null
  const history: History = router?.history
  const subscribe = useCallback((listener: () => void) => (history ? history.subscribe(listener) : windowSubscribe(listener)), [history])
  const handle = useSyncExternalStore(subscribe, () => profileFromSearch(currentSearch(history)), () => undefined)
  const go = useCallback(
    (next: string | undefined, replace: boolean) => {
      const location = history ? history.location : window.location
      const params = new URLSearchParams(location.search)
      if (next) params.set("profile", next)
      else params.delete("profile")
      const query = params.toString()
      const href = `${location.pathname}${query ? `?${query}` : ""}${location.hash}`
      if (history) {
        if (replace) history.replace(href)
        else history.push(href)
        return
      }
      if (replace) window.history.replaceState(window.history.state, "", href)
      else window.history.pushState(window.history.state, "", href)
      window.dispatchEvent(new Event(CHANGE))
    },
    [history],
  )
  const openProfile = useCallback(
    (next: string) => {
      opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null
      // Switching from one profile to another replaces, so Back leaves the sheet.
      go(next.replace(/^@/, ""), Boolean(profileFromSearch(currentSearch(history))))
    },
    [go, history],
  )
  const closeProfile = useCallback(() => go(undefined, true), [go])
  return { handle, openProfile, closeProfile }
}

/* Keep each app shell with the assets from its own build. API and auth requests
 * always go to the server with the browser's credentials. */
const version = new URL(self.location.href).searchParams.get("v") || "dev"
const cacheName = `faztudo-shell-${version}`

try {
  importScripts(`/precache-manifest.js?v=${encodeURIComponent(version)}`)
} catch {
  // The manifest is only emitted for production builds.
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const manifest = self.__FAZTUDO_PRECACHE__
    if (version !== "dev" && manifest?.version !== version) {
      throw new Error("Service worker and asset manifest builds differ")
    }
    if (manifest?.version === version) {
      const page = await fetch("/", { cache: "no-store" })
      if (!page.ok || !(await page.clone().text()).includes(`name="faztudo-build-id" content="${version}"`)) {
        throw new Error("App shell and service worker builds differ")
      }
      const cache = await caches.open(cacheName)
      await cache.put("/", page)
      await cache.addAll(manifest.paths)
    }
    if (!self.registration.active) await self.skipWaiting()
  })())
})

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys()
    await Promise.all(names.filter((name) => name.startsWith("faztudo-shell-") && name !== cacheName).map((name) => caches.delete(name)))
    await self.clients.claim()
  })())
})

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting()
})

function isExcluded(path) {
  return path === "/api" || path.startsWith("/api/") ||
    path === "/mcp" || path.startsWith("/mcp/") ||
    path === "/auth/local" || path === "/ca.crt" ||
    path === "/sw.js" || path === "/precache-manifest.js"
}

function isStatic(path) {
  return path.startsWith("/assets/") || path.startsWith("/fonts/") ||
    path.startsWith("/icons/") || path === "/favicon.svg" ||
    path === "/manifest.webmanifest"
}

self.addEventListener("fetch", (event) => {
  const request = event.request
  const url = new URL(request.url)
  if (request.method !== "GET" || url.origin !== self.location.origin || isExcluded(url.pathname)) return

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        // A live navigation always gets the current index after a deploy.
        return await fetch(request)
      } catch (error) {
        const shell = await (await caches.open(cacheName)).match("/")
        if (shell) return shell
        throw error
      }
    })())
    return
  }

  if (!isStatic(url.pathname)) return
  event.respondWith((async () => {
    let cache
    try {
      cache = await caches.open(cacheName)
    } catch {
      return fetch(request)
    }
    const cached = await cache.match(request)
    if (cached) return cached
    const response = await fetch(request)
    if (response.ok && response.type === "basic") {
      try {
        await cache.put(request, response.clone())
      } catch {
        // Full or disabled storage must not break online use.
      }
    }
    return response
  })())
})

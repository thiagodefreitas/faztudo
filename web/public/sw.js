/* Cache only the app shell and known static assets. API, MCP, and auth exchange
 * requests always go directly to the server with the browser's credentials. */
const version = new URL(self.location.href).searchParams.get("v") || "dev"
const cacheName = `faztudo-shell-${version}`

self.addEventListener("install", (event) => {
  if (!self.registration.active) event.waitUntil(self.skipWaiting())
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
    path === "/sw.js"
}

function isStatic(path) {
  return path.startsWith("/assets/") || path.startsWith("/icons/") ||
    path === "/favicon.svg" || path === "/manifest.webmanifest"
}

self.addEventListener("fetch", (event) => {
  const request = event.request
  const url = new URL(request.url)
  if (request.method !== "GET" || url.origin !== self.location.origin || isExcluded(url.pathname)) return

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      let response
      try {
        response = await fetch(request)
      } catch (error) {
        try {
          const cache = await caches.open(cacheName)
          const shell = await cache.match("/")
          if (shell) return shell
        } catch {
          // There is no offline shell if storage is unavailable.
        }
        throw error
      }
      if (response.ok && response.headers.get("content-type")?.includes("text/html")) {
        try {
          const cache = await caches.open(cacheName)
          await cache.put("/", response.clone())
        } catch {
          // A full or disabled cache must not break an online navigation.
        }
      }
      return response
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
        // Static files remain available from the network.
      }
    }
    return response
  })())
})

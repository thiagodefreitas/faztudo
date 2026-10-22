import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import { describe, expect, it, vi } from "vitest"

const script = readFileSync("public/sw.js", "utf8")

function worker(version: string, manifestVersion = version) {
  const handlers: Record<string, (event: { request?: unknown; waitUntil?: (work: Promise<unknown>) => void; respondWith?: (work: Promise<unknown>) => void }) => void> = {}
  const entries = new Map<string, unknown>()
  const cache = {
    put: vi.fn(async (key: string, value: unknown) => { entries.set(key, value) }),
    match: vi.fn(async (key: string) => entries.get(key)),
    addAll: vi.fn(async (paths: string[]) => { paths.forEach((path) => entries.set(path, { asset: path })) }),
  }
  const response = { ok: true, type: "basic", clone() { return this }, text: async () => `<meta name="faztudo-build-id" content="${version}" />` }
  const fetch = vi.fn(async () => response)
  const self = {
    location: { href: `https://app.test/sw.js?v=${version}`, origin: "https://app.test" },
    registration: { active: null },
    skipWaiting: vi.fn(async () => {}),
    clients: { claim: vi.fn(async () => {}) },
    addEventListener: (name: string, handler: typeof handlers[string]) => { handlers[name] = handler },
    __FAZTUDO_PRECACHE__: undefined as unknown,
  }
  runInNewContext(script, {
    self, URL, encodeURIComponent, fetch,
    caches: { open: async () => cache, keys: async () => [], delete: async () => true },
    importScripts: () => { self.__FAZTUDO_PRECACHE__ = { version: manifestVersion, paths: ["/assets/entry.js", "/assets/app.css", "/fonts/inter-latin-wght.woff2"] } },
  })
  return { handlers, cache, fetch, response }
}

async function dispatch(handler: (event: { waitUntil?: (work: Promise<unknown>) => void; respondWith?: (work: Promise<unknown>) => void; request?: unknown }) => void, request?: unknown) {
  let result: Promise<unknown> | undefined
  handler({ request, waitUntil: (work) => { result = work }, respondWith: (work) => { result = work } })
  return result
}

describe("service worker shell", () => {
  it("precaches the matching entry, CSS, and font", async () => {
    const { handlers, cache } = worker("new")
    await dispatch(handlers.install)
    expect(cache.put).toHaveBeenCalledWith("/", expect.anything())
    expect(cache.addAll).toHaveBeenCalledWith(["/assets/entry.js", "/assets/app.css", "/fonts/inter-latin-wght.woff2"])
  })

  it("rejects a manifest from another build", async () => {
    const { handlers, cache } = worker("new", "old")
    await expect(dispatch(handlers.install)).rejects.toThrow("builds differ")
    expect(cache.put).not.toHaveBeenCalled()
  })

  it("fetches navigation from the network before using the cached shell", async () => {
    const { handlers, cache, fetch, response } = worker("new")
    await dispatch(handlers.install)
    const request = { method: "GET", url: "https://app.test/tasks", mode: "navigate" }
    expect(await dispatch(handlers.fetch, request)).toBe(response)
    expect(fetch).toHaveBeenCalledWith(request)
    expect(cache.put).toHaveBeenCalledTimes(1)
  })

  it("never caches an HTML response under an asset URL", async () => {
    const { handlers, cache, fetch } = worker("new")
    await dispatch(handlers.install)
    cache.put.mockClear()
    const html = { ok: true, type: "basic", headers: { get: () => "text/html; charset=utf-8" }, clone() { return this } }
    fetch.mockResolvedValueOnce(html as never)
    const request = { method: "GET", url: "https://app.test/assets/lanes-OLD.js", mode: "no-cors" }
    expect(await dispatch(handlers.fetch, request)).toBe(html)
    expect(cache.put).not.toHaveBeenCalled()
    const js = { ok: true, type: "basic", headers: { get: () => "text/javascript" }, clone() { return this } }
    fetch.mockResolvedValueOnce(js as never)
    await dispatch(handlers.fetch, { ...request, url: "https://app.test/assets/lanes-NEW.js" })
    expect(cache.put).toHaveBeenCalledTimes(1)
  })
})

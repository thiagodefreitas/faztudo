import { describe, expect, it } from "vitest"
import { router } from "./router"

describe("route loading", () => {
  it("preloads links on intent and delays the pending line", () => {
    expect(router.options.defaultPreload).toBe("intent")
    expect(router.options.defaultPendingMs).toBe(150)
    expect(router.options.defaultPendingMinMs).toBe(0)
  })

  it("keeps heavy pages behind preloadable route components", () => {
    for (const path of ["/office", "/office/3d", "/lanes", "/organization", "/tasks", "/settings/devices"] as const) {
      expect(router.routesByPath[path]?.options.component).toHaveProperty("preload")
    }
  })
})

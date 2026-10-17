import { defineConfig, devices } from "@playwright/test"

export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:5173",
    viewport: { width: 1280, height: 800 },
    reducedMotion: "reduce",
  },
  webServer: {
    command: "npm run dev:mock",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: false,
    timeout: 60_000,
  },
})

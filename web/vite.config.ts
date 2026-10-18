import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vitest/config"
import { mockPlugin } from "./src/mock/plugin"

const useMock = process.env.VITE_USE_MOCK === "1"

export default defineConfig({
  define: { __FAZTUDO_BUILD_ID__: JSON.stringify(Date.now().toString(36)) },
  plugins: [react(), tailwindcss(), ...(useMock ? [mockPlugin()] : [])],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    ...(useMock
      ? {}
      : {
          proxy: {
            "/api": {
              target: "http://127.0.0.1:7457",
              ws: true,
              changeOrigin: true,
            },
          },
        }),
  },
  test: {
    environment: "jsdom",
    // One jsdom worker costs several hundred MB; unbounded workers on a
    // many-core machine exceeded the sandbox memory limit.
    maxWorkers: process.env.FAZTUDO_SANDBOXED === "1" ? 2 : 4,
    setupFiles: "./src/test/setup.ts",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
})

import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vitest/config"
import { mockPlugin } from "./src/mock/plugin"

const useMock = process.env.VITE_USE_MOCK === "1"

export default defineConfig({
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
    setupFiles: "./src/test/setup.ts",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
})

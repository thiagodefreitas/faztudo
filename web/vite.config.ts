import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vitest/config"
import { mockPlugin } from "./src/mock/plugin"

const useMock = process.env.VITE_USE_MOCK === "1"
const buildId = Date.now().toString(36)

export default defineConfig({
  define: { __FAZTUDO_BUILD_ID__: JSON.stringify(buildId) },
  plugins: [react(), tailwindcss(), ...(useMock ? [mockPlugin()] : []), {
    name: "faztudo-precache",
    configureServer(server) {
      server.middlewares.use("/precache-manifest.js", (_request, response) => {
        response.setHeader("content-type", "text/javascript; charset=utf-8")
        response.end(`self.__FAZTUDO_PRECACHE__ = ${JSON.stringify({ version: buildId, paths: ["/fonts/inter-latin-wght.woff2"] })};\n`)
      })
    },
    transformIndexHtml(html) {
      return html.replace("</head>", `    <meta name="faztudo-build-id" content="${buildId}" />\n  </head>`)
    },
    generateBundle(_options, bundle) {
      const entry = Object.values(bundle).find((asset) => asset.type === "chunk" && asset.isEntry)
      if (!entry || entry.type !== "chunk") return
      // Shell only: the entry, its static imports, the CSS and the font. Every
      // route is a dynamic import, so offline the shell opens but a route that
      // was not visited online fails to load. Adding the route chunks would
      // cost about 205 KB gzip (270 KB more with the 3D office), over the
      // 150 KB budget for a precache that runs on every deploy.
      const paths = new Set<string>(["/fonts/inter-latin-wght.woff2"])
      const visit = (fileName: string) => {
        if (paths.has(`/${fileName}`)) return
        paths.add(`/${fileName}`)
        const asset = bundle[fileName]
        if (asset?.type === "chunk") asset.imports.forEach(visit)
      }
      visit(entry.fileName)
      for (const asset of Object.values(bundle)) {
        if (asset.fileName.endsWith(".css")) paths.add(`/${asset.fileName}`)
      }
      this.emitFile({ type: "asset", fileName: "precache-manifest.js", source: `self.__FAZTUDO_PRECACHE__ = ${JSON.stringify({ version: buildId, paths: [...paths] })};\n` })
    },
  }],
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

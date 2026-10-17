import type { IncomingMessage } from "node:http"
import type { Plugin } from "vite"
import { WebSocketServer, type WebSocket } from "ws"
import { realClock } from "./clock"
import { handleMock } from "./http"
import { MockWorld } from "./world"

const attached = new WeakSet<object>()

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > 1_000_000) {
        reject(new Error("body too large"))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    req.on("error", reject)
  })
}

function attachSocket(world: MockWorld, socket: WebSocket): void {
  let unsubscribe = () => {}
  socket.on("message", (data) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(data.toString())
    } catch {
      return
    }
    if (!parsed || typeof parsed !== "object") return
    if ((parsed as { op?: unknown }).op !== "subscribe") return
    const after = (parsed as { after_seq?: unknown }).after_seq
    const afterSeq = typeof after === "number" && Number.isFinite(after) ? after : 0
    unsubscribe()
    unsubscribe = world.subscribe(afterSeq, (event) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event))
    })
  })
  socket.on("close", () => unsubscribe())
}

export function mockPlugin(): Plugin {
  const world = new MockWorld(realClock)
  return {
    name: "faztudo-mock",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1")
        if (!url.pathname.startsWith("/api/")) {
          next()
          return
        }
        void readBody(req)
          .then((raw) => {
            const result = handleMock(world, req.method ?? "GET", url, raw)
            res.statusCode = result.status
            res.setHeader("content-type", "application/json; charset=utf-8")
            res.end(JSON.stringify(result.body))
          })
          .catch(() => {
            if (res.headersSent || res.writableEnded) return
            res.statusCode = 500
            res.setHeader("content-type", "application/json; charset=utf-8")
            res.end(JSON.stringify({ error: { code: "internal", message: "mock failed" } }))
          })
      })

      const httpServer = server.httpServer
      if (!httpServer || attached.has(httpServer)) return
      attached.add(httpServer)
      const wss = new WebSocketServer({ noServer: true })
      httpServer.on("upgrade", (req, socket, head) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1")
        if (url.pathname !== "/api/v1/stream") return
        wss.handleUpgrade(req, socket, head, (ws) => attachSocket(world, ws))
      })
    },
  }
}

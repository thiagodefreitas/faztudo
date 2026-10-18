import { useFrame } from "@react-three/fiber"
import { createContext, useEffect, type ReactNode } from "react"
import { CanvasTexture, RepeatWrapping, SRGBColorSpace } from "three"
import { nextCodeScroll } from "./life"

export const CodeScreenContext = createContext<CanvasTexture | null>(null)

const CODE_LINES = [
  "const pose = state()",
  "if (working) {",
  "  hands.type()",
  "  screen.scroll()",
  "}",
  "lane.ok && commit",
  "return frame + 1",
  "agent.step(now)",
]

function drawCodeScreen(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext("2d")
  if (!ctx) return
  ctx.fillStyle = "#102027"
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.font = "12px ui-monospace, monospace"
  const lineH = 16
  for (let pass = 0; pass < 2; pass += 1) {
    CODE_LINES.forEach((line, index) => {
      const y = 14 + index * lineH + pass * CODE_LINES.length * lineH
      ctx.fillStyle = index % 3 === 0 ? "#7dcea0" : "#d5e7ef"
      ctx.fillText(line, 6, y)
    })
  }
}

let sharedCodeTexture: CanvasTexture | null = null

function codeTexture(): CanvasTexture | null {
  if (sharedCodeTexture) return sharedCodeTexture
  if (typeof document === "undefined") return null
  const canvas = document.createElement("canvas")
  canvas.width = 128
  canvas.height = 256
  drawCodeScreen(canvas)
  const tex = new CanvasTexture(canvas)
  tex.wrapS = RepeatWrapping
  tex.wrapT = RepeatWrapping
  tex.colorSpace = SRGBColorSpace
  tex.anisotropy = 1
  sharedCodeTexture = tex
  return tex
}

export function CodeScreenDriver({ scrolling, children }: { scrolling: boolean; children: ReactNode }) {
  const texture = codeTexture()

  useEffect(() => {
    return () => {
      sharedCodeTexture?.dispose()
      sharedCodeTexture = null
    }
  }, [])

  useFrame((_, delta) => {
    if (!sharedCodeTexture || !scrolling) return
    sharedCodeTexture.offset.y = nextCodeScroll(sharedCodeTexture.offset.y, delta, false)
  })

  return <CodeScreenContext.Provider value={texture}>{children}</CodeScreenContext.Provider>
}

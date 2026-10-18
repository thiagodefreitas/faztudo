// Captures the README, wiki and site screenshots and the short tour video
// from the demo data, never from a real workspace.
//
//   cd web && VITE_USE_MOCK=1 VITE_MOCK_SHOWCASE=1 npx vite --port 5199 &
//   node scripts/capture-media.mjs http://127.0.0.1:5199 ../docs/images /tmp/tour
//
// Writes PNGs into the images folder and tour.webm into the video folder;
// convert the video with ffmpeg (see docs/wiki/Contributing or the commit
// that added this script).
import { mkdirSync, readdirSync, renameSync } from "node:fs"
import { join } from "node:path"
import { chromium } from "playwright"

const [base = "http://127.0.0.1:5199", images = "../docs/images", videoDir = ""] = process.argv.slice(2)
mkdirSync(images, { recursive: true })

const desktop = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1.25 }
const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 4 / 3, isMobile: true, hasTouch: true }

const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"] })

async function page(options) {
  const context = await browser.newContext({ ...options, colorScheme: "light" })
  const p = await context.newPage()
  p.on("pageerror", (error) => console.error("pageerror", error.message))
  return { context, p }
}

// Opens a channel by name through its URL; the phone layout hides the sidebar.
async function openChannel(p, name) {
  await p.goto(base + "/")
  await p.waitForTimeout(1200)
  const channels = await (await p.request.get(base + "/api/v1/channels")).json()
  const channel = channels.find((item) => item.name === name)
  await p.goto(base + "/c/" + channel.id)
  await p.waitForTimeout(1800)
}

async function shot(p, name) {
  await p.screenshot({ path: join(images, name) })
  console.log("wrote", name)
}

{
  const { context, p } = await page(desktop)
  await openChannel(p, "general")
  await shot(p, "chat.png")
  await p.goto(base + "/p/faztudo")
  await p.waitForTimeout(1800)
  await shot(p, "project-home.png")
  await p.goto(base + "/tasks")
  await p.waitForTimeout(1800)
  await shot(p, "tasks-board.png")
  await p.goto(base + "/approvals")
  await p.waitForTimeout(1500)
  const row = p.locator("main button, main [role=button]").filter({ hasText: /approval|Approve|Push|Architect/i }).first()
  if (await row.count()) await row.click().catch(() => {})
  await p.waitForTimeout(1200)
  await shot(p, "approvals.png")
  await p.goto(base + "/office")
  await p.waitForTimeout(2500)
  await shot(p, "office-2d.png")
  await p.goto(base + "/office/3d")
  await p.waitForTimeout(6000)
  await shot(p, "office-3d.png")
  await context.close()
}

{
  const { context, p } = await page(phone)
  await p.goto(base + "/")
  await p.waitForTimeout(2000)
  await shot(p, "inbox-phone.png")
  await openChannel(p, "faztudo-dev")
  await shot(p, "chat-phone.png")
  await context.close()
}

if (videoDir) {
  mkdirSync(videoDir, { recursive: true })
  const context = await browser.newContext({ ...desktop, deviceScaleFactor: 1, recordVideo: { dir: videoDir, size: desktop.viewport } })
  const p = await context.newPage()
  await openChannel(p, "general")
  await p.waitForTimeout(2500)
  await p.getByRole("button", { name: "Runs" }).click().catch(() => {})
  await p.waitForTimeout(1500)
  await p.getByRole("button", { name: "All" }).click().catch(() => {})
  await p.waitForTimeout(800)
  await p.goto(base + "/tasks")
  await p.waitForTimeout(2500)
  await p.goto(base + "/approvals")
  await p.waitForTimeout(2500)
  await p.goto(base + "/p/faztudo")
  await p.waitForTimeout(3000)
  await p.goto(base + "/office")
  await p.waitForTimeout(3500)
  await p.goto(base + "/office/3d")
  await p.waitForTimeout(6000)
  await context.close()
  const [file] = readdirSync(videoDir).filter((name) => name.endsWith(".webm"))
  if (file) renameSync(join(videoDir, file), join(videoDir, "tour.webm"))
  console.log("wrote tour.webm")
}

await browser.close()

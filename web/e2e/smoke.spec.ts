import { mkdirSync } from "node:fs"
import { expect, test } from "@playwright/test"

test("posts a mention, streams a run, and answers the approval", async ({ page }) => {
  mkdirSync("docs-shots", { recursive: true })
  await page.goto("/")
  await expect(page.getByRole("heading", { name: "# faztudo-dev" })).toBeVisible()
  await expect(page.getByText("Building the run card and approvals")).toBeVisible()
  await expect(page.getByText("got exhausted, want conserve").first()).toBeVisible()

  const box = page.getByRole("textbox", { name: "Message" })
  await box.click()
  await box.pressSequentially("@cod")
  await expect(page.getByRole("option", { name: /Coder/ })).toBeVisible()
  await box.press("Enter")
  await expect(box).toHaveValue("@coder ")
  await box.pressSequentially("add a lane health chip")
  await box.press("Enter")

  await expect(page.getByText("diff ready, asking before push").first()).toBeVisible()
  const approval = page.getByRole("article", { name: /Push branch/ })
  await expect(approval).toBeVisible()

  await page.screenshot({ path: "docs-shots/channel-light.png" })
  await page.getByRole("button", { name: "Use dark theme" }).click()
  await page.screenshot({ path: "docs-shots/channel-dark.png" })

  await approval.focus()
  await approval.press("Enter")
  await expect(page.getByText("ok: pushed and verified").first()).toBeVisible()
  await page.getByRole("button", { name: /View diff/ }).last().click()
  await expect(page.getByText("shown on the run card")).toBeVisible()
  await page.getByRole("button", { name: "Close" }).click()

  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole("button", { name: "Channels" }).click()
  await page.getByRole("link", { name: /general/ }).click()
  await expect(page.getByRole("heading", { name: "# general" })).toBeVisible()
})

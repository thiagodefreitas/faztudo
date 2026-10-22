import { mkdirSync } from "node:fs"
import { expect, test } from "@playwright/test"

test("posts a mention, streams a run, and answers the approval", async ({ page }) => {
  mkdirSync("docs-shots", { recursive: true })
  await page.context().addCookies([{
    name: "fz_local", value: "synthetic-mock-cookie", url: "http://127.0.0.1:5173",
    httpOnly: true, sameSite: "Strict",
  }])
  await page.goto("/")
  await page.getByTestId("inbox-list").getByRole("link", { name: /faztudo-dev/ }).click()
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
  // The theme button cycles System, Light, Dark.
  const theme = page.getByRole("button", { name: /^Theme:/ })
  for (let i = 0; i < 3 && !(await page.locator("html.dark").count()); i++) await theme.click()
  await expect(page.locator("html.dark")).toHaveCount(1)
  await page.screenshot({ path: "docs-shots/channel-dark.png" })

  await approval.focus()
  await approval.press("Enter")
  // A passing verification is folded under Details on the run card.
  await page.locator("summary", { hasText: "Details" }).last().click()
  await expect(page.getByText("ok: pushed and verified").first()).toBeVisible()
  await page.getByRole("button", { name: /View diff/ }).last().click()
  await expect(page.getByText("shown on the run card")).toBeVisible()
  await page.getByRole("button", { name: "Close" }).click()

  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole("link", { name: "Back to chats" }).click()
  await page.getByTestId("inbox-list").getByRole("link", { name: /^# general/ }).click()
  await expect(page.getByRole("heading", { name: "# general" })).toBeVisible()
})

test("switching channels keeps one transcript and one composer", async ({ page }) => {
  await page.context().addCookies([{
    name: "fz_local", value: "synthetic-mock-cookie", url: "http://127.0.0.1:5173",
    httpOnly: true, sameSite: "Strict",
  }])
  await page.goto("/")
  await page.getByTestId("inbox-list").getByRole("link", { name: /faztudo-dev/ }).click()
  await expect(page.getByRole("heading", { name: "# faztudo-dev" })).toBeVisible()
  const links = page.locator('aside a[href^="/c/"]')
  const count = await links.count()
  expect(count).toBeGreaterThanOrEqual(2)
  for (let i = 0; i < 6; i++) {
    await links.nth(i % count).click()
    await expect(page.getByTestId("transcript")).toHaveCount(1)
    await expect(page.getByRole("textbox", { name: "Message" })).toHaveCount(1)
  }
})

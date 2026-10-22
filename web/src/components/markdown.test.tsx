import { render, waitFor } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { Markdown } from "./markdown"

describe("Markdown", () => {
  it("renders headings as real headings", () => {
    const view = render(<Markdown text={"## Docs\n\n#### Small"} />)
    expect(view.container.querySelector("h2")?.textContent).toBe("Docs")
    expect(view.container.querySelector("h4")?.textContent).toBe("Small")
  })

  it("adds a copy button to code blocks only", () => {
    const view = render(<Markdown text={"use `inline` here\n\n```go\npackage main\n```"} />)
    expect(view.container.querySelectorAll("button[aria-label='Copy code']")).toHaveLength(1)
  })

  it("loads a fenced code block language after showing plain text", async () => {
    const view = render(<Markdown text={"```go\npackage main\n```"} />)
    expect(view.container.querySelector("code")?.textContent).toContain("package main")
    await waitFor(() => expect(view.container.querySelector(".token.keyword")?.textContent).toBe("package"))
  })

  it("loads an allow-listed language and leaves unknown languages plain", async () => {
    const view = render(<Markdown text={"```python\nprint('hi')\n```\n\n```madeup\njust text\n```"} />)
    await waitFor(() => expect(view.container.querySelector(".hl")?.textContent).toContain("print"))
    expect(view.container.querySelector("code.language-madeup")?.textContent).toBe("just text")
  })
})

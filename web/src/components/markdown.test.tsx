import { render } from "@testing-library/react"
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

  it("highlights a fenced code block", () => {
    const view = render(<Markdown text={"```go\npackage main\n```"} />)
    expect(view.container.querySelector(".token.keyword")?.textContent).toBe("package")
  })
})

import { render } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { Markdown } from "./markdown"

describe("Markdown", () => {
  it("highlights a fenced code block", () => {
    const view = render(<Markdown text={"```go\npackage main\n```"} />)
    expect(view.container.querySelector(".token.keyword")?.textContent).toBe("package")
  })
})

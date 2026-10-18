import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import type { Attachment } from "../types"
import { AttachmentList } from "./attachments"

const png: Attachment = { id: "a".repeat(64), name: "shot.png", content_type: "image/png", size: 2048 }
const pdf: Attachment = { id: "b".repeat(64), name: "report final.pdf", content_type: "application/octet-stream", size: 3 * 1024 * 1024 }
const svg: Attachment = { id: "c".repeat(64), name: "logo.svg", content_type: "application/octet-stream", size: 100 }

describe("AttachmentList", () => {
  it("shows a safe image inline", () => {
    render(<AttachmentList attachments={[png]} />)
    const image = screen.getByRole("img", { name: "shot.png" })
    expect(image).toHaveAttribute("src", `/api/v1/files/${png.id}?name=shot.png`)
  })

  it("shows every other file as a download card with its size", () => {
    render(<AttachmentList attachments={[pdf, svg]} />)
    expect(screen.queryByRole("img")).not.toBeInTheDocument()
    const card = screen.getByRole("link", { name: /report final\.pdf/ })
    expect(card).toHaveAttribute("download", "report final.pdf")
    expect(card).toHaveAttribute("href", `/api/v1/files/${pdf.id}?name=report%20final.pdf`)
    expect(card).toHaveTextContent("3.0 MB")
    expect(screen.getByRole("link", { name: /logo\.svg/ })).toHaveAttribute("download", "logo.svg")
  })

  it("renders nothing without attachments", () => {
    const { container } = render(<AttachmentList attachments={undefined} />)
    expect(container).toBeEmptyDOMElement()
  })
})

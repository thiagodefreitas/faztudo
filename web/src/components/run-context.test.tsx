import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"
import type { RunPrompt } from "../types"
import { RunContext } from "./run-context"

describe("RunContext", () => {
  it("shows byte sizes and folds each prompt section", async () => {
    const user = userEvent.setup()
    const transcript = "café\n".repeat(8)
    const request = "\nRequest:\nFix the issue"
    const transcriptBytes = new TextEncoder().encode(transcript).length
    const requestBytes = new TextEncoder().encode(request).length
    const data: RunPrompt = {
      run_id: "run",
      prompt: transcript + request,
      sections: [
        { name: "transcript", bytes: transcriptBytes, spans: [{ offset: 0, bytes: transcriptBytes }] },
        { name: "request", bytes: requestBytes, spans: [{ offset: transcriptBytes, bytes: requestBytes }] },
      ],
    }
    render(<RunContext data={data} />)
    await user.click(screen.getByText(`Transcript, ${transcriptBytes} B`))
    expect(screen.getByRole("button", { name: "Show all (9 lines)" })).toBeTruthy()
    await user.click(screen.getByText(`Request, ${requestBytes} B`))
    expect(screen.getByText(/Fix the issue/)).toBeTruthy()
  })
})

import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { SpeechEventLike } from "../lib/dictation"
import { DictationButton } from "./dictation-button"

class FakeRecognition {
  static last: FakeRecognition | null = null
  lang = ""
  continuous = false
  interimResults = false
  onresult: ((event: SpeechEventLike) => void) | null = null
  onerror: ((event: { error: string }) => void) | null = null
  onend: (() => void) | null = null
  start = vi.fn()
  stop = vi.fn(() => this.onend?.())
  abort = vi.fn()
  constructor() {
    FakeRecognition.last = this
  }
}

const say = (transcript: string, isFinal: boolean): SpeechEventLike => ({ resultIndex: 0, results: [{ isFinal, 0: { transcript } }] })

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).SpeechRecognition
})

describe("DictationButton", () => {
  it("renders nothing without speech recognition", () => {
    const { container } = render(<DictationButton onText={() => {}} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("sends final words, shows interim ones and stops", async () => {
    ;(window as unknown as Record<string, unknown>).SpeechRecognition = FakeRecognition
    const onText = vi.fn()
    const user = userEvent.setup()
    render(<DictationButton onText={onText} />)
    await user.click(screen.getByRole("button", { name: "Dictate" }))
    const r = FakeRecognition.last!
    expect(r.start).toHaveBeenCalled()
    act(() => r.onresult?.(say("fix the head", false)))
    expect(screen.getByText("fix the head")).toBeInTheDocument()
    act(() => r.onresult?.(say("fix the header", true)))
    expect(onText).toHaveBeenCalledWith("fix the header")
    await user.click(screen.getByRole("button", { name: "Stop dictation" }))
    expect(r.stop).toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "Dictate" })).toBeInTheDocument()
  })

  it("explains a refused microphone", async () => {
    ;(window as unknown as Record<string, unknown>).SpeechRecognition = FakeRecognition
    const user = userEvent.setup()
    render(<DictationButton onText={() => {}} />)
    await user.click(screen.getByRole("button", { name: "Dictate" }))
    act(() => FakeRecognition.last!.onerror?.({ error: "not-allowed" }))
    expect(screen.getByRole("alert")).toHaveTextContent(/refused/)
  })
})

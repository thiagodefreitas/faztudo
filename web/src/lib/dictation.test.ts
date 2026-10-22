import { describe, expect, it } from "vitest"
import { appendDictation, dictationError, onDevice, speechRecognitionOf, transcriptOf, type SpeechRecognitionCtor } from "./dictation"

const result = (transcript: string, isFinal: boolean) => ({ isFinal, 0: { transcript } })

describe("dictation", () => {
  it("finds the standard or prefixed constructor", () => {
    const ctor = function () {} as unknown as SpeechRecognitionCtor
    expect(speechRecognitionOf({ SpeechRecognition: ctor })).toBe(ctor)
    expect(speechRecognitionOf({ webkitSpeechRecognition: ctor })).toBe(ctor)
    expect(speechRecognitionOf({})).toBeNull()
    expect(speechRecognitionOf(undefined)).toBeNull()
  })

  it("splits final and interim text from the result index on", () => {
    const event = { resultIndex: 1, results: [result("old", true), result(" fix the ", true), result("header", false)] }
    expect(transcriptOf(event)).toEqual({ final: "fix the", interim: "header" })
  })

  it("appends with one space", () => {
    expect(appendDictation("", "hello")).toBe("hello")
    expect(appendDictation("@coder", "fix it")).toBe("@coder fix it")
    expect(appendDictation("@coder ", "fix it")).toBe("@coder fix it")
    expect(appendDictation("draft", "")).toBe("draft")
  })

  it("asks the browser about on-device recognition and survives errors", async () => {
    const local = { available: async () => "available" } as unknown as SpeechRecognitionCtor
    const remote = { available: async () => "unavailable" } as unknown as SpeechRecognitionCtor
    const broken = { available: async () => { throw new Error("x") } } as unknown as SpeechRecognitionCtor
    const old = {} as SpeechRecognitionCtor
    expect(await onDevice(local, "en-US")).toBe(true)
    expect(await onDevice(remote, "en-US")).toBe(false)
    expect(await onDevice(broken, "en-US")).toBe(false)
    expect(await onDevice(old, "en-US")).toBe(false)
  })

  it("explains errors and stays quiet on abort", () => {
    expect(dictationError("not-allowed")).toMatch(/refused/)
    expect(dictationError("aborted")).toBe("")
    expect(dictationError("weird")).toMatch(/weird/)
  })
})

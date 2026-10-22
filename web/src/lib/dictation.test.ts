import { describe, expect, it } from "vitest"
import { appendDictation, dictationError, speechRecognitionOf, transcriptOf, type SpeechRecognitionCtor } from "./dictation"

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

  it("explains errors and stays quiet on abort", () => {
    expect(dictationError("not-allowed")).toMatch(/refused/)
    expect(dictationError("aborted")).toBe("")
    expect(dictationError("weird")).toMatch(/weird/)
  })
})

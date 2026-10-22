// Dictation uses the browser's own speech recognition. faztudo never sees the
// audio; where it goes depends on the browser (Chrome sends it to Google's
// speech service unless on-device recognition is available, Safari uses
// Apple's). The button says which one it got.

export interface SpeechResultLike {
  isFinal: boolean
  0: { transcript: string }
}

export interface SpeechEventLike {
  resultIndex: number
  results: ArrayLike<SpeechResultLike>
}

export interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  processLocally?: boolean
  onresult: ((event: SpeechEventLike) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
  abort(): void
}

export interface SpeechRecognitionCtor {
  new (): SpeechRecognitionLike
  available?: (options: { langs: string[]; processLocally: boolean }) => Promise<string>
}

/** The browser's SpeechRecognition constructor, or null when it has none. */
export function speechRecognitionOf(win: unknown): SpeechRecognitionCtor | null {
  if (!win || typeof win !== "object") return null
  const w = win as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

/** Whether recognition for lang can run on the device, when the browser says. */
export async function onDevice(ctor: SpeechRecognitionCtor, lang: string): Promise<boolean> {
  if (typeof ctor.available !== "function") return false
  try {
    return (await ctor.available({ langs: [lang], processLocally: true })) === "available"
  } catch {
    return false
  }
}

/** Splits the results of one event into final text and the interim tail. */
export function transcriptOf(event: SpeechEventLike): { final: string; interim: string } {
  let final = ""
  let interim = ""
  for (let i = event.resultIndex; i < event.results.length; i++) {
    const result = event.results[i]
    if (result.isFinal) final += result[0].transcript
    else interim += result[0].transcript
  }
  return { final: final.trim(), interim: interim.trim() }
}

/** Appends dictated words to the draft with one space between them. */
export function appendDictation(draft: string, words: string): string {
  if (!words) return draft
  if (!draft) return words
  return /\s$/.test(draft) ? draft + words : `${draft} ${words}`
}

/** A plain sentence for a recognition error code. */
export function dictationError(code: string): string {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone access was refused. Allow it in the browser's site settings."
    case "no-speech":
      return "No speech was heard."
    case "audio-capture":
      return "No microphone was found."
    case "network":
      return "The browser's speech service could not be reached."
    case "aborted":
      return ""
    default:
      return `Dictation stopped (${code}).`
  }
}

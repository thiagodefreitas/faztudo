import { useEffect, useRef, useState } from "react"
import { dictationError, speechRecognitionOf, transcriptOf, type SpeechRecognitionLike } from "../lib/dictation"

/**
 * A microphone button for the composer. It renders nothing when the browser
 * has no speech recognition. Final words go to onText; the words still being
 * heard show under the box until they settle.
 */
export function DictationButton({ onText }: { onText: (words: string) => void }) {
  const ctor = typeof window === "undefined" ? null : speechRecognitionOf(window)
  const lang = typeof navigator === "undefined" ? "en-US" : navigator.language || "en-US"
  const [listening, setListening] = useState(false)
  const [interim, setInterim] = useState("")
  const [error, setError] = useState("")
  const recognition = useRef<SpeechRecognitionLike | null>(null)
  const sink = useRef(onText)
  useEffect(() => {
    sink.current = onText
  }, [onText])

  useEffect(() => () => recognition.current?.abort(), [])

  if (!ctor) return null

  const stop = () => recognition.current?.stop()
  const start = () => {
    setError("")
    setInterim("")
    const r = new ctor()
    r.lang = lang
    r.continuous = true
    r.interimResults = true
    r.onresult = (event) => {
      const { final, interim } = transcriptOf(event)
      if (final) sink.current(final)
      setInterim(interim)
    }
    r.onerror = (event) => setError(dictationError(event.error))
    r.onend = () => {
      setListening(false)
      setInterim("")
      recognition.current = null
    }
    recognition.current = r
    try {
      r.start()
      setListening(true)
    } catch {
      setError("Dictation could not start.")
      recognition.current = null
    }
  }

  const title = listening ? "Stop dictation" : "Dictate (your browser's speech service recognizes it)"
  return (
    <>
      <button
        type="button"
        aria-label={listening ? "Stop dictation" : "Dictate"}
        aria-pressed={listening}
        title={title}
        onClick={listening ? stop : start}
        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-colors duration-150 md:h-8 md:w-8 ${
          listening ? "bg-danger-soft text-danger" : "text-muted hover:bg-sidebar hover:text-ink"
        }`}
      >
        <svg viewBox="0 0 20 20" className="h-[18px] w-[18px]" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <rect x="7.5" y="3" width="5" height="9" rx="2.5" />
          <path d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.5" />
        </svg>
      </button>
      <span className="sr-only" aria-live="polite">
        {listening ? "Listening" : ""}
      </span>
      {(interim || error) && (
        <span role={error ? "alert" : undefined} className="pointer-events-none absolute -top-6 left-3 max-w-[90%] truncate text-[12px] text-muted">
          {error || interim}
        </span>
      )}
    </>
  )
}

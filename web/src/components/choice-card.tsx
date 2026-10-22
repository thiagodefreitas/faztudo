import { cx } from "../lib/cx"
import { choiceForKey, choiceLetter } from "../lib/choices"

// The options an agent offered with ask_human. Tapping one, or pressing its
// letter while the card has focus, answers. `answered` is the chosen index.
export function ChoiceCard({
  options,
  answered,
  onChoose,
  error,
}: {
  options: string[]
  answered: number | null
  onChoose: (index: number) => void
  error?: string | null
}) {
  return (
    <div
      role="group"
      aria-label="Choices"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.ctrlKey || event.metaKey || event.altKey || answered !== null) return
        const index = choiceForKey(event.key, options.length)
        if (index === null) return
        event.preventDefault()
        onChoose(index)
      }}
      className="fz-rise mt-2 flex max-w-md flex-col gap-1 rounded-xl border border-line bg-surface p-1.5 outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      {options.map((option, index) => {
        const chosen = answered === index
        return (
          <button
            key={index}
            type="button"
            disabled={answered !== null}
            aria-pressed={answered !== null ? chosen : undefined}
            onClick={() => onChoose(index)}
            className={cx(
              "flex min-h-10 items-center gap-2 rounded-lg border px-2.5 text-left text-[13px] transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent md:min-h-9",
              chosen ? "border-accent bg-accent-soft text-ink" : "border-transparent bg-canvas text-ink",
              answered === null ? "hover:border-line hover:bg-sidebar" : !chosen && "opacity-60",
            )}
          >
            <kbd className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded bg-line font-mono text-[11px] text-muted">
              {choiceLetter(index)}
            </kbd>
            <span className="min-w-0 flex-1">{option}</span>
            {chosen && <span className="text-[11px] font-medium text-accent">Chosen</span>}
          </button>
        )
      })}
      {error && (
        <p role="alert" className="text-[12px] text-danger">
          {error}
        </p>
      )}
    </div>
  )
}

import { cx } from "../../lib/cx"
import { FILTERS, type ChatFilter } from "./filters"

export function FilterChips({ value, onChange }: { value: ChatFilter; onChange: (filter: ChatFilter) => void }) {
  return (
    <div role="group" aria-label="Filter messages" className="flex gap-1 overflow-x-auto border-b border-line px-3 py-1.5 md:px-4">
      {FILTERS.map((filter) => (
        <button
          key={filter.id}
          type="button"
          aria-pressed={value === filter.id}
          onClick={() => onChange(filter.id)}
          className={cx(
            "min-h-9 shrink-0 rounded-md px-2.5 text-[12px] transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent md:min-h-7",
            value === filter.id ? "bg-accent-soft font-medium text-accent" : "text-muted hover:bg-sidebar hover:text-ink",
          )}
        >
          {filter.label}
        </button>
      ))}
    </div>
  )
}

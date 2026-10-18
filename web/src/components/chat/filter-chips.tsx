import { cx } from "../../lib/cx"
import { FILTERS, type ChatFilter } from "./filters"

export function FilterChips({ value, onChange }: { value: ChatFilter; onChange: (filter: ChatFilter) => void }) {
  return (
    <div role="group" aria-label="Filter messages" className="flex gap-1.5 overflow-x-auto px-3 pb-2 md:border-b md:border-line md:pt-1.5">
      {FILTERS.map((filter) => (
        <button
          key={filter.id}
          type="button"
          aria-pressed={value === filter.id}
          onClick={() => onChange(filter.id)}
          className={cx(
            "min-h-8 shrink-0 rounded-full border px-3 text-[12px]",
            value === filter.id ? "border-accent bg-accent-soft text-accent" : "border-line text-muted hover:bg-sidebar hover:text-ink",
          )}
        >
          {filter.label}
        </button>
      ))}
    </div>
  )
}

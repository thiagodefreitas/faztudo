import { Link } from "@tanstack/react-router"
import type { ReactNode } from "react"
import { cx } from "../lib/cx"

// Shared look for the work pages (Lanes, Organization, Devices, Tasks,
// projects): one header shape, one card shape, one empty state.

/** A card: same radius, border and soft shadow on every work page. */
export const CARD = "rounded-xl border border-line bg-surface shadow-[0_1px_2px_rgb(16_24_40/0.05)]"

/** The main action of a page. */
export const PRIMARY_BUTTON =
  "inline-flex min-h-10 shrink-0 items-center justify-center gap-1.5 rounded-lg bg-accent px-3 text-[13px] font-medium text-canvas transition-opacity duration-150 hover:opacity-90 disabled:opacity-50 md:min-h-8"

/** A secondary action next to it. */
export const SECONDARY_BUTTON =
  "inline-flex min-h-10 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-[13px] font-medium text-ink transition-colors duration-150 hover:bg-sidebar disabled:opacity-50 md:min-h-8"

/** A quiet text action, for links inside a section heading. */
export const TEXT_ACTION = "rounded text-[12px] font-medium text-accent hover:underline"

/** Small uppercase label above a group of cards. */
export const SECTION_LABEL = "text-[11px] font-medium uppercase tracking-wide text-faint"

export function PageHeader({
  title,
  description,
  actions,
  back = true,
  children,
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  /** Shows an Inbox link on the phone, where the sidebar is hidden. */
  back?: boolean
  children?: ReactNode
}) {
  return (
    <header className="border-b border-line bg-canvas px-4 py-3">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        {back && (
          <Link
            to="/"
            aria-label="Back to Inbox"
            className="-my-1.5 -ml-2 inline-flex h-10 w-8 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-sidebar hover:text-ink md:hidden"
          >
            <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="m12 4-6 6 6 6" />
            </svg>
          </Link>
        )}
        <div className="min-w-[min(100%,15rem)] flex-1 basis-60">
          <h1 className="truncate text-[17px] font-semibold leading-7 tracking-tight text-ink">{title}</h1>
          {description && <p className="mt-0.5 max-w-[70ch] text-[13px] text-muted">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </header>
  )
}

/** An empty state that says what fills the place and offers the next step. */
export function EmptyState({ children, action, className }: { children: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cx("flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-dashed border-line px-3 py-3 text-[13px] text-muted", className)}>
      <div className="min-w-0 flex-1">{children}</div>
      {action}
    </div>
  )
}

/** A keyboard key, for shortcut hints. */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex min-w-5 items-center justify-center rounded border border-line bg-canvas px-1 font-sans text-[11px] font-medium tabular-nums text-muted">
      {children}
    </kbd>
  )
}

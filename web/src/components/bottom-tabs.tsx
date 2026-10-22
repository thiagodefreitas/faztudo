import * as Menu from "@radix-ui/react-dropdown-menu"
import { Link } from "@tanstack/react-router"
import type { ReactNode } from "react"
import { cx } from "../lib/cx"
import { pendingApprovals } from "../lib/projects"
import { THEME_LABEL, nextTheme, useTheme } from "../lib/theme"
import { useApprovals } from "../state/queries"
import { ThemeIcon } from "./sidebar"

const TAB = "relative flex min-h-12 flex-1 flex-col items-center justify-center gap-0.5 pt-0.5 text-[11px] font-medium transition-colors"
const ITEM = "flex min-h-10 cursor-default items-center gap-2 rounded px-2 text-[13px] text-ink outline-none data-[highlighted]:bg-accent-soft"

const ICON = {
  viewBox: "0 0 20 20",
  className: "h-5 w-5",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const

const ICONS: Record<"chats" | "projects" | "office" | "more", ReactNode> = {
  chats: (
    <svg {...ICON}>
      <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h9A1.5 1.5 0 0 1 16 5.5v6a1.5 1.5 0 0 1-1.5 1.5H9l-3.5 3v-3h0A1.5 1.5 0 0 1 4 11.5Z" />
    </svg>
  ),
  projects: (
    <svg {...ICON}>
      <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H8l1.5 1.8h6A1.5 1.5 0 0 1 17 8.3v6.2a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 14.5Z" />
    </svg>
  ),
  office: (
    <svg {...ICON}>
      <rect x="4" y="3.5" width="12" height="13" rx="1.5" />
      <path d="M7.5 7h1M11.5 7h1M7.5 10h1M11.5 10h1M8.5 16.5v-3h3v3" />
    </svg>
  ),
  more: (
    <svg {...ICON}>
      <circle cx="5" cy="10" r="1" />
      <circle cx="10" cy="10" r="1" />
      <circle cx="15" cy="10" r="1" />
    </svg>
  ),
}

/** Chats, Projects and Office are tabs on the phone; the rest sits under More. */
export function tabOf(pathname: string): "chats" | "projects" | "office" | null {
  if (pathname === "/" || pathname.startsWith("/c/")) return "chats"
  if (pathname === "/p" || pathname.startsWith("/p/")) return "projects"
  if (pathname.startsWith("/office")) return "office"
  return null
}

/**
 * The phone's bottom bar. A channel hides it so the composer keeps the bottom
 * edge; the channel header has its own back button.
 */
export function showTabs(pathname: string): boolean {
  return !pathname.startsWith("/c/") && pathname !== "/login" && pathname !== "/pair"
}

// The current tab gets a short bar on top as well as the accent color.
function Mark({ on }: { on: boolean }) {
  return on ? <span className="absolute inset-x-5 top-0 h-0.5 rounded-full bg-accent" aria-hidden="true" /> : null
}

export function BottomTabs({ pathname }: { pathname: string }) {
  const theme = useTheme()
  const approvals = useApprovals()
  const count = pendingApprovals(approvals.data ?? []).length
  const active = tabOf(pathname)
  const tab = (name: "chats" | "projects" | "office") => cx(TAB, active === name ? "text-accent" : "text-muted")
  return (
    <nav aria-label="Main" className="flex shrink-0 border-t border-line bg-surface md:hidden">
      <Link to="/" className={tab("chats")} aria-current={active === "chats" ? "page" : undefined}>
        <Mark on={active === "chats"} />
        {ICONS.chats}
        Chats
      </Link>
      <Link to="/p" className={tab("projects")} aria-current={active === "projects" ? "page" : undefined}>
        <Mark on={active === "projects"} />
        {ICONS.projects}
        Projects
      </Link>
      <Link to="/office" className={tab("office")} aria-current={active === "office" ? "page" : undefined}>
        <Mark on={active === "office"} />
        {ICONS.office}
        Office
      </Link>
      <Menu.Root>
        <Menu.Trigger className={cx(TAB, active === null ? "text-accent" : "text-muted")}>
          <Mark on={active === null} />
          {ICONS.more}
          More
          {count > 0 && (
            <span
              className="absolute left-1/2 top-1 ml-1.5 min-w-4 rounded-full bg-warn px-1 text-center text-[10px] font-semibold leading-4 tabular-nums text-canvas"
              aria-label={`${count} waiting for you`}
            >
              {count}
            </span>
          )}
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Content align="end" side="top" sideOffset={6} className="z-50 min-w-44 rounded-md border border-line bg-surface p-1 shadow-lg">
            <Menu.Item asChild>
              <Link to="/approvals" className={cx(ITEM, "justify-between", count > 0 && "font-medium text-warn")}>
                <span>Needs you</span>
                {count > 0 && (
                  <span className="min-w-5 rounded-full bg-warn px-1.5 text-center text-[11px] font-medium leading-[18px] tabular-nums text-canvas" aria-label={`${count} waiting`}>
                    {count}
                  </span>
                )}
              </Link>
            </Menu.Item>
            <Menu.Item asChild>
              <Link to="/lanes" className={ITEM}>
                Lanes
              </Link>
            </Menu.Item>
            <Menu.Item asChild>
              <Link to="/tasks" className={ITEM}>
                Tasks
              </Link>
            </Menu.Item>
            <Menu.Item asChild>
              <Link to="/organization" className={ITEM}>
                Organization
              </Link>
            </Menu.Item>
            <Menu.Item asChild>
              <Link to="/routines" className={ITEM}>
                Routines
              </Link>
            </Menu.Item>
            <Menu.Item asChild>
              <Link to="/settings/devices" className={ITEM}>
                Devices
              </Link>
            </Menu.Item>
            <Menu.Separator className="my-1 h-px bg-line" />
            <Menu.Item
              onSelect={(event) => {
                // Keep the menu open so System, Light and Dark can be tried in turn.
                event.preventDefault()
                theme.cycle()
              }}
              aria-label={`Theme: ${THEME_LABEL[theme.preference]}. Switch to ${THEME_LABEL[nextTheme(theme.preference)]}.`}
              className={ITEM}
            >
              <ThemeIcon choice={theme.preference} />
              <span>Theme: {THEME_LABEL[theme.preference]}</span>
            </Menu.Item>
          </Menu.Content>
        </Menu.Portal>
      </Menu.Root>
    </nav>
  )
}

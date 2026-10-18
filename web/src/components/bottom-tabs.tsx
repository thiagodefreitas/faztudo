import * as Menu from "@radix-ui/react-dropdown-menu"
import { Link } from "@tanstack/react-router"
import { cx } from "../lib/cx"
import { useTheme } from "../lib/theme"

const TAB = "flex min-h-12 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium"
const ITEM = "flex min-h-10 cursor-default items-center rounded px-2 text-[13px] text-ink outline-none data-[highlighted]:bg-accent-soft"

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

export function BottomTabs({ pathname }: { pathname: string }) {
  const theme = useTheme()
  const active = tabOf(pathname)
  const tab = (name: "chats" | "projects" | "office") => cx(TAB, active === name ? "text-accent" : "text-muted")
  return (
    <nav aria-label="Main" className="flex shrink-0 border-t border-line bg-surface md:hidden">
      <Link to="/" className={tab("chats")} aria-current={active === "chats" ? "page" : undefined}>
        Chats
      </Link>
      <Link to="/p" className={tab("projects")} aria-current={active === "projects" ? "page" : undefined}>
        Projects
      </Link>
      <Link to="/office" className={tab("office")} aria-current={active === "office" ? "page" : undefined}>
        Office
      </Link>
      <Menu.Root>
        <Menu.Trigger className={cx(TAB, active === null ? "text-accent" : "text-muted")}>More</Menu.Trigger>
        <Menu.Portal>
          <Menu.Content align="end" side="top" sideOffset={6} className="z-50 min-w-44 rounded-md border border-line bg-surface p-1 shadow-lg">
            <Menu.Item asChild>
              <Link to="/approvals" className={ITEM}>
                Needs you
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
            <Menu.Item onSelect={theme.toggle} className={ITEM}>
              {theme.choice === "dark" ? "Use light theme" : "Use dark theme"}
            </Menu.Item>
          </Menu.Content>
        </Menu.Portal>
      </Menu.Root>
    </nav>
  )
}

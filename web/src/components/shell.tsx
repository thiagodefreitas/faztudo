import { Outlet, useRouterState } from "@tanstack/react-router"
import { useLiveStream } from "../state/live"
import { BottomTabs, showTabs } from "./bottom-tabs"
import { LaneGauges } from "./lane-gauges"
import { Notifier } from "./notifier"
import { CommandPalette } from "./palette"
import { SearchDialog } from "./search-dialog"
import { Sidebar } from "./sidebar"
import { PwaStatus } from "./pwa-status"

function LiveStreamBridge() {
  useLiveStream()
  return null
}

export function Shell() {
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const standalone = pathname === "/login" || pathname === "/pair"
  if (standalone) {
    return <Outlet />
  }
  return (
    <div className="flex h-full min-h-0 bg-canvas text-ink">
      <LiveStreamBridge />
      <Sidebar />
      <CommandPalette />
      <SearchDialog />
      <Notifier />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <LaneGauges />
        <Outlet />
        <PwaStatus />
        {showTabs(pathname) && <BottomTabs pathname={pathname} />}
      </div>
    </div>
  )
}


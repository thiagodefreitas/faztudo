import { Outlet } from "@tanstack/react-router"
import { useLiveStream } from "../state/live"
import { Sidebar } from "./sidebar"

export function Shell() {
  useLiveStream()
  return (
    <div className="flex h-dvh min-h-0 bg-canvas text-ink">
      <Sidebar />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <Outlet />
      </div>
    </div>
  )
}

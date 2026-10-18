import { Link, getRouteApi } from "@tanstack/react-router"
import { useNow } from "../../state/now"
import { useApprovals, useChannels, useOrg, useRuns, useTasks } from "../../state/queries"
import type { Approval, Run, Task } from "../../types"
import { digestItems, type DigestKind } from "./digest"

const routeApi = getRouteApi("/projects/$handle/activity")

export function ProjectActivityPage() {
  const { handle } = routeApi.useParams()
  const { kind, period } = routeApi.useSearch()
  const org = useOrg()
  const channels = useChannels()
  const runs = useRuns()
  const approvals = useApprovals()
  const tasks = useTasks()
  const now = useNow()
  const project = org.data?.projects.find((item) => item.handle.toLowerCase() === handle.toLowerCase())
  if (!project) return <p className="p-4 text-[13px] text-muted">Project not found.</p>
  const items = digestItems(project, channels.data ?? [], runs.data ?? [], approvals.data ?? [], tasks.data ?? [], period, new Date(now))
  const list: (Run | Approval | Task)[] = items[kind] instanceof Array ? items[kind] : []
  const title: Record<DigestKind, string> = { merged: "Merged runs", failed: "Failed runs", waiting: "Waiting on you", tasks: "Tasks done", usage: "Usage" }
  return <section className="min-h-0 flex-1 overflow-y-auto p-3">
    <div className="mx-auto max-w-2xl space-y-3">
      <Link to="/p/$handle" params={{ handle }} className="text-[13px] text-accent hover:underline">Back to {project.name}</Link>
      <h1 className="text-[17px] font-semibold">{title[kind]} {period === "today" ? "today" : "in the last 7 days"}</h1>
      {list.length === 0 ? <p className="text-[13px] text-muted">Nothing in this list.</p> : <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
        {list.map((item) => {
          if ("lane_id" in item) return <li key={item.id}><Link to="/c/$channelId" params={{ channelId: item.channel_id }} search={{ run: item.id }} className="block min-h-10 p-2 text-[13px] hover:bg-canvas">Run {item.id.slice(0, 8)} · {item.state} · {item.lane_id}</Link></li>
          if ("options" in item) return <li key={item.id}><Link to="/approvals" search={{ a: item.id }} className="block min-h-10 p-2 text-[13px] hover:bg-canvas">{item.title}</Link></li>
          return <li key={item.id}><Link to="/p/$handle/tasks" params={{ handle }} className="block min-h-10 p-2 text-[13px] hover:bg-canvas">{item.title}</Link></li>
        })}
      </ul>}
    </div>
  </section>
}

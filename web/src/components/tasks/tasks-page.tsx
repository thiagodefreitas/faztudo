import { Link, getRouteApi } from "@tanstack/react-router"
import { useState } from "react"
import { channelsOfProject } from "../../lib/projects"
import { tasksIn } from "../../lib/tasks"
import { useChannels, useMembers, useOrg, useTasks } from "../../state/queries"
import { AllWork } from "./all-work"
import { TaskBoard } from "./task-board"
import { TaskBuilder } from "./task-builder"

const VIEW_KEY = "faztudo.tasks.view"

function readView(): "tasks" | "all" {
  try {
    return localStorage.getItem(VIEW_KEY) === "all" ? "all" : "tasks"
  } catch {
    return "tasks"
  }
}

const projectApi = getRouteApi("/p/$handle/tasks")

export function TasksPage() {
  return <TasksView />
}

export function ProjectTasksPage() {
  const { handle } = projectApi.useParams()
  return <TasksView handle={handle} />
}

// The board for every channel, or for the channels of one project.
export function TasksView({ handle }: { handle?: string }) {
  const tasks = useTasks()
  const members = useMembers()
  const channels = useChannels()
  const org = useOrg()
  const [building, setBuilding] = useState(false)
  const [view, setViewState] = useState<"tasks" | "all">(readView)

  function setView(next: "tasks" | "all") {
    setViewState(next)
    try {
      localStorage.setItem(VIEW_KEY, next)
    } catch {
      // The choice still holds for this page.
    }
  }

  const project = handle ? org.data?.projects.find((item) => item.handle.toLowerCase() === handle.toLowerCase()) : undefined
  if (handle && org.isPending) return <p className="p-4 text-[13px] text-muted">Loading project</p>
  if (handle && !project) return <p className="p-4 text-[13px] text-muted">Project not found.</p>

  const usable = (channels.data ?? []).filter((channel) => channel.kind !== "direct")
  const scope = project ? channelsOfProject(project, usable) : usable
  const visible = project ? tasksIn(tasks.data ?? [], new Set(scope.map((channel) => channel.id))) : (tasks.data ?? [])

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="tasks-page">
      <header className="flex items-center gap-3 border-b border-line px-3 py-2">
        <Link to="/" className="min-h-10 py-2 text-[13px] text-muted md:hidden">
          Inbox
        </Link>
        <h1 className="min-w-0 flex-1 truncate text-[15px] font-semibold">{project ? `${project.name} tasks` : "Tasks"}</h1>
        {project && (
          <Link to="/p/$handle" params={{ handle: project.handle }} className="text-[13px] text-accent hover:underline">
            Project home
          </Link>
        )}
        <button
          type="button"
          onClick={() => setBuilding(true)}
          disabled={scope.length === 0}
          className="min-h-10 rounded-md bg-accent px-3 text-[13px] font-medium text-canvas hover:opacity-90 disabled:opacity-50 md:min-h-8"
        >
          New task
        </button>
      </header>
      <div role="group" aria-label="View" className="flex gap-1 border-b border-line px-3 py-1.5">
        {(["tasks", "all"] as const).map((key) => (
          <button
            key={key}
            type="button"
            aria-pressed={view === key}
            onClick={() => setView(key)}
            className={`min-h-10 rounded-md px-3 text-[13px] md:min-h-8 ${view === key ? "bg-sidebar font-medium text-ink" : "text-muted hover:text-ink"}`}
          >
            {key === "tasks" ? "Tasks" : "All work"}
          </button>
        ))}
      </div>
      {view === "all" ? (
        <AllWork channels={channels.data ?? []} channelIds={project ? new Set(scope.map((channel) => channel.id)) : undefined} />
      ) : tasks.isPending ? (
        <p className="p-4 text-[13px] text-muted">Loading tasks</p>
      ) : (
        <TaskBoard tasks={visible} members={members.data ?? []} channels={channels.data ?? []} showChannel={scope.length > 1} />
      )}
      <TaskBuilder open={building} onOpenChange={setBuilding} channels={scope} />
    </section>
  )
}

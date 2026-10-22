import { Link, getRouteApi } from "@tanstack/react-router"
import { useState } from "react"
import { channelsOfProject } from "../../lib/projects"
import { tasksIn } from "../../lib/tasks"
import { useChannels, useMembers, useOrg, useTasks } from "../../state/queries"
import { AllWork } from "./all-work"
import { TaskBoard } from "./task-board"
import { TaskBuilder } from "./task-builder"
import { PageHeader, PRIMARY_BUTTON, SECONDARY_BUTTON } from "../page-header"

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
      <PageHeader
        title={project ? `${project.name} tasks` : "Tasks"}
        description={view === "all" ? "Every run of the last 24 hours, by where it stands." : "Work you gave the team, from Todo to Done."}
        actions={
          <>
            {project && (
              <Link to="/p/$handle" params={{ handle: project.handle }} className={SECONDARY_BUTTON}>
                Project home
              </Link>
            )}
            <button type="button" onClick={() => setBuilding(true)} disabled={scope.length === 0} className={PRIMARY_BUTTON}>
              New task
            </button>
          </>
        }
      >
        <div role="group" aria-label="View" className="mt-3 inline-flex rounded-lg bg-sidebar p-0.5">
          {(["tasks", "all"] as const).map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={view === key}
              onClick={() => setView(key)}
              className={`min-h-9 rounded-md px-3 text-[13px] transition-colors duration-150 md:min-h-7 ${view === key ? "bg-surface font-medium text-ink shadow-[0_1px_2px_rgb(16_24_40/0.08)]" : "text-muted hover:text-ink"}`}
            >
              {key === "tasks" ? "Tasks" : "All work"}
            </button>
          ))}
        </div>
      </PageHeader>
      {view === "all" ? (
        <AllWork channels={channels.data ?? []} channelIds={project ? new Set(scope.map((channel) => channel.id)) : undefined} />
      ) : tasks.isPending ? (
        <p className="p-4 text-[13px] text-muted">Loading tasks</p>
      ) : (
        <TaskBoard
          tasks={visible}
          members={members.data ?? []}
          channels={channels.data ?? []}
          showChannel={scope.length > 1}
          {...(scope.length > 0 ? { onAdd: () => setBuilding(true) } : {})}
        />
      )}
      <TaskBuilder open={building} onOpenChange={setBuilding} channels={scope} />
    </section>
  )
}

import { useQueryClient } from "@tanstack/react-query"
import { useState, type DragEvent } from "react"
import { api } from "../../api/client"
import { COLUMN_TITLES, moveInTodo, statusLabel, taskColumns, type TaskColumns } from "../../lib/tasks"
import { qk } from "../../state/keys"
import type { Channel, Member, Task } from "../../types"
import { AgentAvatar } from "../agent-avatar"
import { TaskDetail } from "./task-detail"

const ORDER = ["todo", "running", "review", "done"] as const
const ARROW = "flex h-8 w-8 shrink-0 items-center justify-center rounded text-muted hover:bg-sidebar hover:text-ink md:h-6 md:w-6"

// The board: Todo, Running, Review and Done. Todo cards can be reordered by
// dragging or with the arrow buttons; a card opens its task.
export function TaskBoard({ tasks, members, channels, showChannel = false }: { tasks: Task[]; members: Member[]; channels: Channel[]; showChannel?: boolean }) {
  const qc = useQueryClient()
  const columns = taskColumns(tasks)
  const [openId, setOpenId] = useState<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const open = tasks.find((task) => task.id === openId)

  function move(id: string, toIndex: number) {
    const order = moveInTodo(columns.todo, id, toIndex)
    if (order === null) return
    const before = qc.getQueryData<Task[]>(qk.tasks)
    qc.setQueryData<Task[]>(qk.tasks, (current) => current?.map((task) => (task.id === id ? { ...task, order } : task)))
    api.patchTask(id, { order }).catch(() => qc.setQueryData(qk.tasks, before))
  }

  function drop(event: DragEvent, targetIndex: number) {
    event.preventDefault()
    const id = event.dataTransfer.getData("text/plain") || dragId
    setDragId(null)
    if (id) move(id, targetIndex)
  }

  return (
    <>
      <div className="grid min-h-0 flex-1 gap-3 overflow-y-auto p-3 md:grid-cols-4 md:overflow-x-auto">
        {ORDER.map((key) => (
          <Column key={key} id={key} list={columns[key]}>
            {columns[key].map((task, index) => {
              const agent = members.find((member) => member.handle === task.assignee)
              const channel = channels.find((item) => item.id === task.channel_id)
              const draggable = key === "todo"
              return (
                <li
                  key={task.id}
                  draggable={draggable}
                  onDragStart={(event) => {
                    event.dataTransfer.setData("text/plain", task.id)
                    event.dataTransfer.effectAllowed = "move"
                    setDragId(task.id)
                  }}
                  onDragOver={(event) => draggable && event.preventDefault()}
                  onDrop={(event) => draggable && drop(event, index)}
                  onDragEnd={() => setDragId(null)}
                  className={`flex items-start gap-1 rounded-md border border-line bg-surface p-1.5 ${dragId === task.id ? "opacity-50" : ""}`}
                >
                  <button type="button" onClick={() => setOpenId(task.id)} className="min-w-0 flex-1 rounded p-1 text-left hover:bg-canvas">
                    <span className="flex items-center gap-1.5">
                      <AgentAvatar member={agent} size={20} state={task.status === "running" ? "working" : task.status === "review" ? "waiting" : undefined} decorative />
                      <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{task.title}</span>
                    </span>
                    <span className="mt-0.5 block truncate text-[12px] text-muted">
                      {agent?.display_name ?? `@${task.assignee}`} - {task.mode}
                      {showChannel && channel ? ` - #${channel.name}` : ""}
                    </span>
                    {key !== "todo" && (
                      <span className={`mt-1 inline-block rounded-full border px-2 text-[11px] ${task.status === "failed" ? "border-danger text-danger" : "border-line text-ink"}`}>{statusLabel(task.status)}</span>
                    )}
                  </button>
                  {draggable && (
                    <span className="flex shrink-0 flex-col">
                      {index > 0 && (
                        <button type="button" aria-label={`Move ${task.title} up`} onClick={() => move(task.id, index - 1)} className={ARROW}>
                          <span aria-hidden="true">^</span>
                        </button>
                      )}
                      {index < columns.todo.length - 1 && (
                        <button type="button" aria-label={`Move ${task.title} down`} onClick={() => move(task.id, index + 1)} className={ARROW}>
                          <span aria-hidden="true">v</span>
                        </button>
                      )}
                    </span>
                  )}
                </li>
              )
            })}
          </Column>
        ))}
      </div>
      {open && (
        <TaskDetail
          task={open}
          agent={members.find((member) => member.handle === open.assignee)}
          channel={channels.find((item) => item.id === open.channel_id)}
          onClose={() => setOpenId(null)}
        />
      )}
    </>
  )
}

function Column({ id, list, children }: { id: keyof TaskColumns; list: Task[]; children: React.ReactNode }) {
  const title = COLUMN_TITLES[id]
  return (
    <section aria-label={title} className="flex min-w-0 flex-col rounded-lg bg-sidebar/50 p-2 md:min-w-56">
      <h2 className="mb-1.5 flex items-baseline gap-2 px-1 text-[11px] font-medium uppercase tracking-wide text-faint">
        {title}
        <span className="font-mono normal-case">{list.length}</span>
      </h2>
      {list.length === 0 ? (
        <p className="px-1 py-2 text-[13px] text-muted">Nothing here.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">{children}</ul>
      )}
    </section>
  )
}

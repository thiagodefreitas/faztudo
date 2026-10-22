import { useQueryClient } from "@tanstack/react-query"
import { useState, type DragEvent, type ReactNode } from "react"
import { api } from "../../api/client"
import { cx } from "../../lib/cx"
import { COLUMN_TITLES, moveInTodo, statusLabel, taskColumns, type TaskColumns } from "../../lib/tasks"
import { formatAge } from "../../lib/time"
import { qk } from "../../state/keys"
import { useNow } from "../../state/now"
import type { Channel, Member, Task, TaskStatus } from "../../types"
import { AgentAvatar } from "../agent-avatar"
import { TaskDetail } from "./task-detail"

const ORDER = ["todo", "running", "review", "done"] as const
const ARROW =
  "flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-faint transition-colors duration-150 hover:bg-sidebar hover:text-ink md:h-6 md:w-6"

const STATUS_PILL: Record<TaskStatus, string> = {
  todo: "bg-sidebar text-muted",
  running: "bg-accent-soft text-accent",
  review: "bg-warn-soft text-warn",
  failed: "bg-danger-soft text-danger",
  done: "bg-ok-soft text-ok",
  cancelled: "bg-sidebar text-faint",
}

// The board: Todo, Running, Review and Done. Columns are as tall as their
// cards. Todo cards can be reordered by dragging or with the arrow buttons;
// a card opens its task. onAdd puts a quick "Add" in the Todo column.
export function TaskBoard({
  tasks,
  members,
  channels,
  showChannel = false,
  onAdd,
}: {
  tasks: Task[]
  members: Member[]
  channels: Channel[]
  showChannel?: boolean
  onAdd?: () => void
}) {
  const qc = useQueryClient()
  const now = useNow()
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
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="grid items-start gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4">
          {ORDER.map((key) => (
            <Column
              key={key}
              id={key}
              list={columns[key]}
              action={
                key === "todo" && onAdd ? (
                  <button
                    type="button"
                    onClick={onAdd}
                    className="-my-1 ml-auto inline-flex min-h-8 items-center gap-1 rounded-md px-2 text-[12px] font-medium normal-case tracking-normal text-muted transition-colors duration-150 hover:bg-surface hover:text-ink md:min-h-7"
                  >
                    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                      <path d="M8 3.5v9M3.5 8h9" />
                    </svg>
                    Add
                  </button>
                ) : undefined
              }
            >
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
                    className={cx(
                      "flex items-start gap-1 rounded-lg border border-line bg-surface p-1 shadow-[0_1px_2px_rgb(16_24_40/0.05)] transition-[border-color,opacity] duration-150 hover:border-faint/50",
                      draggable && "cursor-grab active:cursor-grabbing",
                      dragId === task.id && "opacity-50",
                    )}
                  >
                    <button type="button" onClick={() => setOpenId(task.id)} className="min-w-0 flex-1 rounded-md p-1.5 text-left">
                      <span className="line-clamp-2 break-words text-[13px] font-medium leading-snug text-ink" title={task.title}>
                        {task.title}
                      </span>
                      {showChannel && channel && <span className="mt-0.5 block truncate text-[12px] text-muted">#{channel.name}</span>}
                      <span className="mt-2 flex min-w-0 items-center gap-1.5 text-[12px] text-muted">
                        <AgentAvatar
                          member={agent}
                          size={20}
                          state={task.status === "running" ? "working" : task.status === "review" ? "waiting" : task.status === "failed" ? "failed" : undefined}
                          decorative
                        />
                        <span className="min-w-0 truncate">{agent?.display_name ?? `@${task.assignee}`}</span>
                        {task.lane && <span className="hidden min-w-0 truncate font-mono text-[11px] text-faint sm:inline">{task.lane}</span>}
                        <span className="ml-auto flex shrink-0 items-center gap-1.5">
                          {key !== "todo" && (
                            <span className={cx("rounded-full px-2 text-[11px] font-medium leading-[18px]", STATUS_PILL[task.status])}>{statusLabel(task.status)}</span>
                          )}
                          <time dateTime={task.updated_at} className="text-[11px] tabular-nums text-faint">
                            {shortAge(task.updated_at, now)}
                          </time>
                        </span>
                      </span>
                    </button>
                    {draggable && (index > 0 || index < columns.todo.length - 1) && (
                      <span className="flex shrink-0 flex-col">
                        {index > 0 && (
                          <button type="button" aria-label={`Move ${task.title} up`} onClick={() => move(task.id, index - 1)} className={ARROW}>
                            <Chevron up />
                          </button>
                        )}
                        {index < columns.todo.length - 1 && (
                          <button type="button" aria-label={`Move ${task.title} down`} onClick={() => move(task.id, index + 1)} className={ARROW}>
                            <Chevron />
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

// "3h" instead of "3h ago": the card is small and the column says the rest.
function shortAge(at: string, now: number): string {
  const age = formatAge(at, now)
  return age.endsWith(" ago") ? age.slice(0, -4) : age === "age unknown" ? "" : age
}

function Chevron({ up = false }: { up?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" className={cx("h-3.5 w-3.5", up && "rotate-180")} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="m4 6 4 4 4-4" />
    </svg>
  )
}

function Column({ id, list, action, children }: { id: keyof TaskColumns; list: Task[]; action?: ReactNode; children: ReactNode }) {
  const title = COLUMN_TITLES[id]
  return (
    <section aria-label={title} className="flex min-w-0 flex-col rounded-xl bg-sidebar/60 p-2">
      <h2 className="mb-2 flex min-h-6 items-center gap-2 px-1 text-[11px] font-medium uppercase tracking-wide text-faint">
        {title}
        <span className="rounded-full bg-surface px-1.5 font-medium tabular-nums normal-case text-muted">{list.length}</span>
        {action}
      </h2>
      {list.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line px-2 py-3 text-center text-[12px] text-faint">Nothing here.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">{children}</ul>
      )}
    </section>
  )
}

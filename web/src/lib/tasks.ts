import type { RunMode, Task, TaskStatus } from "../types"

export interface TaskColumns {
  todo: Task[]
  running: Task[]
  review: Task[]
  done: Task[]
}

export const COLUMN_TITLES: Record<keyof TaskColumns, string> = {
  todo: "Todo",
  running: "Running",
  review: "Review",
  done: "Done",
}

const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "Todo",
  running: "Running",
  review: "Waiting for you",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
}

export function statusLabel(status: TaskStatus): string {
  return STATUS_LABELS[status]
}

/**
 * The four board columns. A failed task sits in Review because it needs a
 * decision (start it again or drop it); a cancelled one sits in Done.
 */
export function taskColumns(tasks: Task[]): TaskColumns {
  const columns: TaskColumns = { todo: [], running: [], review: [], done: [] }
  for (const task of tasks) {
    if (task.status === "todo") columns.todo.push(task)
    else if (task.status === "running") columns.running.push(task)
    else if (task.status === "review" || task.status === "failed") columns.review.push(task)
    else columns.done.push(task)
  }
  columns.todo.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
  for (const key of ["running", "review", "done"] as const) {
    columns[key].sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id))
  }
  return columns
}

export function tasksIn(tasks: Task[], channelIds: Set<string>): Task[] {
  return tasks.filter((task) => channelIds.has(task.channel_id))
}

/** An order that sorts between two neighbours, or past an end. */
export function orderBetween(before: number | undefined, after: number | undefined): number {
  if (before === undefined && after === undefined) return 1
  if (before === undefined) return (after as number) - 1
  if (after === undefined) return before + 1
  return (before + after) / 2
}

/**
 * The new order for a Todo task dragged to position toIndex among the other
 * Todo tasks, or null when it would stay where it is.
 */
export function moveInTodo(todos: Task[], id: string, toIndex: number): number | null {
  const from = todos.findIndex((task) => task.id === id)
  if (from < 0) return null
  const others = todos.filter((task) => task.id !== id)
  const to = Math.max(0, Math.min(toIndex, others.length))
  if (to === from) return null
  return orderBetween(others[to - 1]?.order, others[to]?.order)
}

/** "/task" or "/task Some title" opens the builder instead of sending. */
export function parseTaskCommand(text: string): { title: string } | null {
  const match = /^\s*\/task(?:\s+([\s\S]*))?$/.exec(text)
  if (!match) return null
  return { title: (match[1] ?? "").trim() }
}

/** The lines of a text area, trimmed, without empty ones. */
export function linesOf(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
}

export interface TaskTemplate {
  key: "implement" | "review" | "investigate" | "docs"
  label: string
  mode: RunMode
  title: string
  body: string
  checks: string[]
  acceptance: string[]
}

export const TASK_TEMPLATES: TaskTemplate[] = [
  {
    key: "implement",
    label: "Implement",
    mode: "write",
    title: "Implement ",
    body: "Describe the change and why it is needed.",
    checks: [],
    acceptance: ["The change works as described", "Existing tests still pass"],
  },
  {
    key: "review",
    label: "Review",
    mode: "read",
    title: "Review ",
    body: "Review the change for correctness, security and clarity. Report findings by severity.",
    checks: [],
    acceptance: ["Each finding names the file and line", "Say what is fine as well as what is not"],
  },
  {
    key: "investigate",
    label: "Investigate",
    mode: "read",
    title: "Investigate ",
    body: "Find the cause. Do not change files.",
    checks: [],
    acceptance: ["The cause is stated with evidence", "A fix is proposed, with its risk"],
  },
  {
    key: "docs",
    label: "Docs",
    mode: "write",
    title: "Document ",
    body: "Write or update the documentation for this.",
    checks: [],
    acceptance: ["The text matches what the code does", "Examples run as written"],
  },
]

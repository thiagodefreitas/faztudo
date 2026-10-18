import { describe, expect, it } from "vitest"
import type { Task } from "../types"
import { TASK_TEMPLATES, linesOf, moveInTodo, orderBetween, parseTaskCommand, statusLabel, taskColumns, tasksIn } from "./tasks"

const task = (id: string, status: Task["status"], over: Partial<Task> = {}): Task => ({
  id,
  channel_id: "c1",
  title: `Task ${id}`,
  assignee: "coder",
  mode: "read",
  scope: [],
  checks: [],
  acceptance: [],
  status,
  order: 1,
  run_ids: [],
  created_by: "h1",
  created_at: "2026-10-18T10:00:00Z",
  updated_at: "2026-10-18T10:00:00Z",
  ...over,
})

describe("taskColumns", () => {
  it("puts each status in one of the four columns", () => {
    const columns = taskColumns([
      task("a", "todo"),
      task("b", "running"),
      task("c", "review"),
      task("d", "failed"),
      task("e", "done"),
      task("f", "cancelled"),
    ])
    expect(columns.todo.map((t) => t.id)).toEqual(["a"])
    expect(columns.running.map((t) => t.id)).toEqual(["b"])
    expect(columns.review.map((t) => t.id).sort()).toEqual(["c", "d"])
    expect(columns.done.map((t) => t.id).sort()).toEqual(["e", "f"])
  })

  it("orders Todo by order and the others by the newest change", () => {
    const columns = taskColumns([
      task("late", "todo", { order: 3 }),
      task("early", "todo", { order: 1 }),
      task("old", "done", { updated_at: "2026-10-18T09:00:00Z" }),
      task("new", "done", { updated_at: "2026-10-18T11:00:00Z" }),
    ])
    expect(columns.todo.map((t) => t.id)).toEqual(["early", "late"])
    expect(columns.done.map((t) => t.id)).toEqual(["new", "old"])
  })
})

describe("reordering", () => {
  it("finds an order between two neighbours, or past an end", () => {
    expect(orderBetween(1, 3)).toBe(2)
    expect(orderBetween(undefined, 4)).toBe(3)
    expect(orderBetween(4, undefined)).toBe(5)
    expect(orderBetween(undefined, undefined)).toBe(1)
  })

  const todos = [task("a", "todo", { order: 1 }), task("b", "todo", { order: 2 }), task("c", "todo", { order: 3 })]

  it("moves a task to a position among the others", () => {
    expect(moveInTodo(todos, "c", 0)).toBe(0)
    expect(moveInTodo(todos, "a", 2)).toBe(4)
    expect(moveInTodo(todos, "a", 1)).toBe(2.5)
  })

  it("reports no change when the task stays where it is", () => {
    expect(moveInTodo(todos, "b", 1)).toBeNull()
    expect(moveInTodo(todos, "missing", 0)).toBeNull()
  })

  it("clamps the position", () => {
    expect(moveInTodo(todos, "a", 99)).toBe(4)
    expect(moveInTodo(todos, "c", -5)).toBe(0)
  })
})

describe("the /task command", () => {
  it("opens the builder, with the rest as the title", () => {
    expect(parseTaskCommand("/task")).toEqual({ title: "" })
    expect(parseTaskCommand("  /task Fix the login ")).toEqual({ title: "Fix the login" })
  })

  it("ignores other text", () => {
    expect(parseTaskCommand("/tasks")).toBeNull()
    expect(parseTaskCommand("please /task")).toBeNull()
    expect(parseTaskCommand("@coder fix")).toBeNull()
  })
})

describe("helpers", () => {
  it("splits a text area into trimmed lines", () => {
    expect(linesOf(" web/ \n\n internal/api \n")).toEqual(["web/", "internal/api"])
    expect(linesOf("")).toEqual([])
  })

  it("has the four templates with a default mode each", () => {
    expect(TASK_TEMPLATES.map((t) => t.key)).toEqual(["implement", "review", "investigate", "docs"])
    expect(TASK_TEMPLATES.find((t) => t.key === "implement")?.mode).toBe("write")
    expect(TASK_TEMPLATES.find((t) => t.key === "review")?.mode).toBe("read")
  })

  it("labels the statuses in plain words", () => {
    expect(statusLabel("review")).toBe("Waiting for you")
    expect(statusLabel("failed")).toBe("Failed")
  })

  it("keeps the tasks of some channels", () => {
    const list = [task("a", "todo"), task("b", "todo", { channel_id: "c2" })]
    expect(tasksIn(list, new Set(["c2"])).map((t) => t.id)).toEqual(["b"])
  })
})

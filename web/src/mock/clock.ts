export interface Clock {
  now: () => number
  schedule: (fn: () => void, ms: number) => () => void
}

export const realClock: Clock = {
  now: () => Date.now(),
  schedule(fn, ms) {
    const id = setTimeout(fn, ms)
    return () => clearTimeout(id)
  },
}

interface Task {
  at: number
  fn: () => void
  dead: boolean
}

export class ManualClock implements Clock {
  private time: number
  private tasks: Task[] = []

  constructor(start = Date.parse("2026-10-18T12:00:00.000Z")) {
    this.time = start
  }

  now(): number {
    return this.time
  }

  schedule(fn: () => void, ms: number): () => void {
    const task: Task = { at: this.time + ms, fn, dead: false }
    this.tasks.push(task)
    return () => {
      task.dead = true
    }
  }

  advance(ms: number): void {
    const target = this.time + ms
    for (;;) {
      const pending = this.tasks.filter((task) => !task.dead).sort((a, b) => a.at - b.at)
      const next = pending[0]
      if (!next || next.at > target) break
      this.time = next.at
      next.dead = true
      next.fn()
    }
    this.time = target
  }
}

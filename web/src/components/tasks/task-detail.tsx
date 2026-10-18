import * as Dialog from "@radix-ui/react-dialog"
import { useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useState, type ReactNode } from "react"
import { api } from "../../api/client"
import { statusLabel } from "../../lib/tasks"
import { qk } from "../../state/keys"
import { replaceById } from "../../state/merge"
import { useApprovals, useRuns } from "../../state/queries"
import type { Channel, Member, Task } from "../../types"
import { AgentAvatar } from "../agent-avatar"

const BUTTON = "min-h-10 rounded-md border border-line px-3 text-[13px] hover:bg-sidebar md:min-h-8"
const LINK = "text-[13px] text-accent hover:underline"

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Request failed"
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="mt-3">
      <h3 className="text-[11px] font-medium uppercase tracking-wide text-faint">{title}</h3>
      {children}
    </section>
  )
}

function List({ items, mono = false }: { items: string[]; mono?: boolean }) {
  return (
    <ul className={`mt-1 list-disc space-y-0.5 pl-4 text-[13px] ${mono ? "font-mono" : ""}`}>
      {items.map((item, index) => (
        <li key={index}>{item}</li>
      ))}
    </ul>
  )
}

// One task: its directive, the runs and approval that report back to it, and
// the actions its state allows.
export function TaskDetail({
  task,
  agent,
  channel,
  onClose,
}: {
  task: Task
  agent: Member | undefined
  channel: Channel | undefined
  onClose: () => void
}) {
  const qc = useQueryClient()
  const runs = useRuns()
  const approvals = useApprovals()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const taskRuns = task.run_ids.map((id) => runs.data?.find((run) => run.id === id)).filter((run) => run !== undefined)
  const approval = task.approval_id ? approvals.data?.find((item) => item.id === task.approval_id) : undefined
  const approvalRun = approval?.run_id ?? task.run_ids.at(-1)

  async function act(work: () => Promise<Task>) {
    setError(null)
    setBusy(true)
    try {
      const updated = await work()
      qc.setQueryData<Task[]>(qk.tasks, (current) => replaceById(current ?? [], updated))
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusy(false)
    }
  }

  const canStart = task.status === "todo" || task.status === "failed"
  const canCancel = task.status === "todo" || task.status === "running"

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[min(34rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-md border border-line bg-surface p-4 shadow-lg">
          <Dialog.Title className="text-[15px] font-semibold">{task.title}</Dialog.Title>
          <Dialog.Description className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted">
            <AgentAvatar member={agent} size={20} decorative />
            <span>{agent?.display_name ?? `@${task.assignee}`}</span>
            <span>{task.mode === "write" ? "write" : "read"}</span>
            <span>{task.lane ?? "automatic lane"}</span>
            {channel && <span>#{channel.name}</span>}
            <span className="rounded-full border border-line px-2 text-[11px] text-ink">{statusLabel(task.status)}</span>
          </Dialog.Description>

          {task.body && (
            <Section title="Directive">
              <p className="mt-1 whitespace-pre-wrap text-[13px]">{task.body}</p>
            </Section>
          )}
          {task.scope.length > 0 && (
            <Section title="Scope">
              <List items={task.scope} mono />
            </Section>
          )}
          {task.checks.length > 0 && (
            <Section title="Checks">
              <List items={task.checks} mono />
            </Section>
          )}
          {task.acceptance.length > 0 && (
            <Section title="Acceptance criteria">
              <List items={task.acceptance} />
            </Section>
          )}

          {(taskRuns.length > 0 || approval) && (
            <Section title="Runs">
              <ul className="mt-1 divide-y divide-line rounded-md border border-line text-[13px]">
                {taskRuns.map((run, index) => (
                  <li key={run.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 py-1.5">
                    <span className="min-w-0 flex-1">
                      Run {index + 1}: {run.state.replace("_", " ")} on {run.lane_id}
                    </span>
                    <Link to="/c/$channelId" params={{ channelId: run.channel_id }} search={{ run: run.id }} className={LINK} aria-label={taskRuns.length > 1 ? `Open run ${index + 1}` : undefined}>
                      Open run
                    </Link>
                    <Link to="/c/$channelId" params={{ channelId: run.channel_id }} search={{ run: run.id, view: "timeline" }} className={LINK} aria-label={taskRuns.length > 1 ? `Open timeline of run ${index + 1}` : undefined}>
                      Open timeline
                    </Link>
                  </li>
                ))}
              </ul>
              {approval && approvalRun && (
                <p className="mt-2 text-[13px]">
                  Approval: {approval.state === "pending" ? "waiting for you" : "decided"}.{" "}
                  <Link to="/c/$channelId" params={{ channelId: approval.channel_id }} search={{ run: approvalRun }} className={LINK}>
                    Open approval
                  </Link>
                </p>
              )}
            </Section>
          )}

          {error && (
            <p role="alert" className="mt-3 text-[12px] text-danger">
              {error}
            </p>
          )}
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            {canCancel && (
              <button type="button" disabled={busy} onClick={() => void act(() => api.cancelTask(task.id))} className={BUTTON}>
                Cancel task
              </button>
            )}
            <Dialog.Close className={BUTTON}>Close</Dialog.Close>
            {canStart && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void act(() => api.startTask(task.id))}
                className="min-h-10 rounded-md bg-accent px-3 text-[13px] font-medium text-canvas hover:opacity-90 disabled:opacity-50 md:min-h-8"
              >
                {task.status === "failed" ? "Start again" : "Start"}
              </button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

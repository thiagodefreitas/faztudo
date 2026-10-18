import * as Dialog from "@radix-ui/react-dialog"
import { useQueryClient } from "@tanstack/react-query"
import { useId, useState, type FormEvent, type ReactNode } from "react"
import { api } from "../../api/client"
import { linesOf, TASK_TEMPLATES, type TaskTemplate } from "../../lib/tasks"
import { qk } from "../../state/keys"
import { replaceById } from "../../state/merge"
import { useMembers } from "../../state/queries"
import type { Channel, Member, RunMode, Task } from "../../types"
import { AgentAvatar } from "../agent-avatar"

const FIELD = "mt-1 w-full rounded-md border border-line bg-canvas px-2 text-[13px]"
const BUTTON = "min-h-10 rounded-md border border-line px-3 text-[13px] hover:bg-sidebar md:min-h-8"
const PRIMARY = "min-h-10 rounded-md bg-accent px-3 text-[13px] font-medium text-canvas hover:opacity-90 disabled:opacity-50 md:min-h-8"

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Request failed"
}

function Labeled({ label, help, children }: { label: string; help?: string; children: (id: string) => ReactNode }) {
  const id = useId()
  return (
    <div className="mt-3">
      <label htmlFor={id} className="text-[13px] font-medium">
        {label}
      </label>
      {children(id)}
      {help && <p className="mt-0.5 text-[12px] text-muted">{help}</p>}
    </div>
  )
}

export function TaskBuilder({
  open,
  onOpenChange,
  channels,
  channelId,
  initialTitle = "",
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The channels a task can go to. Not shown when channelId is set. */
  channels: Channel[]
  channelId?: string | undefined
  initialTitle?: string
  onCreated?: (task: Task) => void
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[min(36rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-md border border-line bg-surface p-4 shadow-lg">
          <Dialog.Title className="text-[15px] font-semibold">New task</Dialog.Title>
          <Dialog.Description className="mt-1 text-[12px] text-muted">
            A clear directive for one agent. Starting it posts the directive in the channel and runs the agent.
          </Dialog.Description>
          <BuilderForm channels={channels} channelId={channelId} initialTitle={initialTitle} onDone={(task) => { onOpenChange(false); onCreated?.(task) }} onCancel={() => onOpenChange(false)} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function BuilderForm({
  channels,
  channelId,
  initialTitle,
  onDone,
  onCancel,
}: {
  channels: Channel[]
  channelId: string | undefined
  initialTitle: string
  onDone: (task: Task) => void
  onCancel: () => void
}) {
  const qc = useQueryClient()
  const members = useMembers()
  const agents = (members.data ?? []).filter((member): member is Member => member.kind === "agent")
  const [channel, setChannel] = useState(channelId ?? (channels.length === 1 ? (channels[0]?.id ?? "") : ""))
  const [title, setTitle] = useState(initialTitle)
  const [body, setBody] = useState("")
  const [assignee, setAssignee] = useState<string | null>(null)
  const [lane, setLane] = useState("")
  const [mode, setMode] = useState<RunMode>("read")
  const [scope, setScope] = useState("")
  const [checks, setChecks] = useState("")
  const [acceptance, setAcceptance] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const selected = assignee ?? agents[0]?.handle ?? ""
  const agent = agents.find((item) => item.handle === selected)
  const laneChoices = agent?.agent?.lanes ?? []

  function applyTemplate(template: TaskTemplate) {
    const known = new Set(TASK_TEMPLATES.map((item) => item.title))
    if (!title.trim() || known.has(title)) setTitle(template.title)
    setBody(template.body)
    setMode(template.mode)
    setChecks(template.checks.join("\n"))
    setAcceptance(template.acceptance.join("\n"))
  }

  async function submit(start: boolean) {
    if (!channel) return setError("Choose a channel for the task.")
    if (!title.trim()) return setError("Give the task a title.")
    if (!selected) return setError("There is no agent to give the task to.")
    setError(null)
    setBusy(true)
    try {
      const created = await api.createTask({
        channel_id: channel,
        title: title.trim(),
        ...(body.trim() ? { body: body.trim() } : {}),
        assignee: selected,
        ...(lane && laneChoices.includes(lane) ? { lane } : {}),
        mode,
        scope: linesOf(scope),
        checks: linesOf(checks),
        acceptance: linesOf(acceptance),
        ...(start ? { start: true } : {}),
      })
      qc.setQueryData<Task[]>(qk.tasks, (current) => replaceById(current ?? [], created))
      onDone(created)
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      noValidate
      onSubmit={(event: FormEvent) => {
        event.preventDefault()
        void submit(false)
      }}
    >
      <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label="Templates">
        {TASK_TEMPLATES.map((template) => (
          <button key={template.key} type="button" onClick={() => applyTemplate(template)} className="min-h-8 rounded-full border border-line px-3 text-[12px] hover:bg-sidebar">
            {template.label}
          </button>
        ))}
      </div>

      {!channelId && (
        <Labeled label="Channel">
          {(id) => (
            <select id={id} value={channel} onChange={(event) => setChannel(event.target.value)} className={`${FIELD} min-h-10 md:min-h-8`}>
              <option value="">Choose a channel</option>
              {channels.map((item) => (
                <option key={item.id} value={item.id}>
                  #{item.name}
                </option>
              ))}
            </select>
          )}
        </Labeled>
      )}

      <Labeled label="Title">
        {(id) => <input id={id} value={title} onChange={(event) => setTitle(event.target.value)} maxLength={200} className={`${FIELD} min-h-10 md:min-h-8`} />}
      </Labeled>

      <fieldset className="mt-3">
        <legend className="text-[13px] font-medium">Assignee</legend>
        <div role="radiogroup" aria-label="Assignee" className="mt-1 flex flex-wrap gap-1.5">
          {agents.map((member) => (
            <label key={member.id} className="flex min-h-10 cursor-pointer items-center gap-1.5 rounded-md border border-line px-2 text-[13px] has-[:checked]:border-accent has-[:checked]:bg-accent-soft has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent md:min-h-8">
              <input type="radio" name="assignee" value={member.handle} checked={selected === member.handle} onChange={() => { setAssignee(member.handle); setLane("") }} className="sr-only" />
              <AgentAvatar member={member} size={20} decorative />
              {member.display_name}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Labeled label="Lane" help="Empty uses the agent's lane order.">
          {(id) => (
            <select id={id} value={lane} onChange={(event) => setLane(event.target.value)} className={`${FIELD} min-h-10 md:min-h-8`}>
              <option value="">Automatic</option>
              {laneChoices.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          )}
        </Labeled>
        <fieldset className="mt-3">
          <legend className="text-[13px] font-medium">Mode</legend>
          <div role="radiogroup" aria-label="Mode" className="mt-1 flex gap-1.5">
            {(["read", "write"] as const).map((value) => (
              <label key={value} className="flex min-h-10 cursor-pointer items-center rounded-md border border-line px-3 text-[13px] has-[:checked]:border-accent has-[:checked]:bg-accent-soft has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent md:min-h-8">
                <input type="radio" name="mode" value={value} checked={mode === value} onChange={() => setMode(value)} className="sr-only" />
                {value === "read" ? "Read" : "Write"}
              </label>
            ))}
          </div>
          <p className="mt-0.5 text-[12px] text-muted">Write changes files in a worktree and asks you to merge.</p>
        </fieldset>
      </div>

      <Labeled label="Directive">
        {(id) => <textarea id={id} value={body} onChange={(event) => setBody(event.target.value)} rows={3} className={`${FIELD} py-1.5`} />}
      </Labeled>
      <Labeled label="Scope" help="Paths or areas it may touch, one per line.">
        {(id) => <textarea id={id} value={scope} onChange={(event) => setScope(event.target.value)} rows={2} className={`${FIELD} py-1.5 font-mono`} />}
      </Labeled>
      <Labeled label="Checks" help="Commands to run and report, one per line.">
        {(id) => <textarea id={id} value={checks} onChange={(event) => setChecks(event.target.value)} rows={2} className={`${FIELD} py-1.5 font-mono`} />}
      </Labeled>
      <Labeled label="Acceptance criteria" help="What done means, one per line.">
        {(id) => <textarea id={id} value={acceptance} onChange={(event) => setAcceptance(event.target.value)} rows={2} className={`${FIELD} py-1.5`} />}
      </Labeled>

      {error && (
        <p role="alert" className="mt-3 text-[12px] text-danger">
          {error}
        </p>
      )}
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <button type="button" onClick={onCancel} className={BUTTON}>
          Cancel
        </button>
        <button type="submit" disabled={busy} className={BUTTON}>
          Add to Todo
        </button>
        <button type="button" disabled={busy} onClick={() => void submit(true)} className={PRIMARY}>
          Start now
        </button>
      </div>
    </form>
  )
}

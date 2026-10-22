import * as Dialog from "@radix-ui/react-dialog"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useId, useState, type FormEvent, type ReactNode } from "react"
import { ApiError, api } from "../api/client"
import { cx } from "../lib/cx"
import { qk } from "../state/keys"
import { replaceById } from "../state/merge"
import { useMembers } from "../state/queries"
import type { BridgeBinding, Channel, ChannelPatch, Member } from "../types"
import { DevicesPanel } from "./auth"

export const CHANNEL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export const inputClass = "mt-1 min-h-8 w-full rounded-md border border-line bg-canvas px-2 text-[13px]"
export const buttonClass = "min-h-8 rounded-md border border-line px-3 text-[13px]"

export function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return "Request failed"
}

export function Field({
  label,
  help,
  error,
  children,
}: {
  label: string
  help?: string
  error?: string | null
  children: (ids: { id: string; describedBy: string }) => ReactNode
}) {
  const id = useId()
  const helpId = `${id}-help`
  const errorId = `${id}-error`
  const describedBy = [help ? helpId : "", error ? errorId : ""].filter(Boolean).join(" ")
  return (
    <div className="mt-3">
      <label htmlFor={id} className="text-[13px] font-medium">
        {label}
      </label>
      {children({ id, describedBy })}
      {help && (
        <p id={helpId} className="mt-1 text-[12px] text-muted">
          {help}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="mt-1 text-[12px] text-danger">
          {error}
        </p>
      )}
    </div>
  )
}

// Shell is the frame every creation and settings dialog shares.
export function Shell({
  title,
  description,
  onSubmit,
  submitLabel,
  busy,
  formError,
  children,
}: {
  title: string
  description: string
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  submitLabel: string
  busy: boolean
  formError?: string | null
  children: ReactNode
}) {
  return (
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/40" />
      <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-md border border-line bg-surface p-4 shadow-lg">
        <Dialog.Title className="text-[15px] font-semibold">{title}</Dialog.Title>
        <Dialog.Description className="mt-1 text-[12px] text-muted">{description}</Dialog.Description>
        <form onSubmit={onSubmit} noValidate>
          {children}
          {formError && (
            <p role="alert" className="mt-3 text-[12px] text-danger">
              {formError}
            </p>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <Dialog.Close type="button" className={buttonClass}>
              Cancel
            </Dialog.Close>
            <button
              type="submit"
              disabled={busy}
              className="min-h-8 rounded-md bg-accent px-3 text-[13px] text-canvas disabled:opacity-60"
            >
              {busy ? "Saving" : submitLabel}
            </button>
          </div>
        </form>
      </Dialog.Content>
    </Dialog.Portal>
  )
}

export function ChannelSettingsDialog({
  channel,
  agents,
  open,
  onOpenChange,
  initialTab = "channel",
}: {
  channel: Channel
  agents: Member[]
  open: boolean
  onOpenChange: (open: boolean) => void
  initialTab?: "channel" | "devices" | "bridge"
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      {open && (
        <SettingsForm
          key={`${channel.id}:${initialTab}`}
          channel={channel}
          agents={agents}
          initialTab={initialTab}
          onDone={() => onOpenChange(false)}
        />
      )}
    </Dialog.Root>
  )
}

function SettingsForm({
  channel,
  agents,
  initialTab = "channel",
  onDone,
}: {
  channel: Channel
  agents: Member[]
  initialTab?: "channel" | "devices" | "bridge"
  onDone: () => void
}) {
  const qc = useQueryClient()
  const [tab, setTab] = useState<"channel" | "devices" | "bridge">(initialTab)
  const [topic, setTopic] = useState(channel.topic ?? "")
  const [repoPath, setRepoPath] = useState(channel.repo_path ?? "")
  const [testCommand, setTestCommand] = useState(channel.test_command ?? "")
  const [defaultAgent, setDefaultAgent] = useState(channel.default_agent_id ?? "")
  const [busy, setBusy] = useState(false)
  const [repoError, setRepoError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    const patch: ChannelPatch = {
      topic: topic.trim(),
      repo_path: repoPath.trim(),
      test_command: testCommand.trim(),
      default_agent_id: defaultAgent,
    }
    setBusy(true)
    setRepoError(null)
    setFormError(null)
    api.patchChannel(channel.id, patch).then(
      (next) => {
        qc.setQueryData<Channel[]>(qk.channels, (list = []) => replaceById(list, next))
        setBusy(false)
        onDone()
      },
      (error: unknown) => {
        setBusy(false)
        const message = errorText(error)
        if (error instanceof ApiError && /repo_path|git|repo/i.test(message)) setRepoError(message)
        else setFormError(message)
      },
    )
  }

  const tabs = (
    <div role="tablist" aria-label="Settings sections" className="mt-3 flex gap-1 border-b border-line pb-2">
      <button
        type="button"
        role="tab"
        aria-selected={tab === "channel"}
        onClick={() => setTab("channel")}
        className={cx(
          "min-h-8 rounded px-2.5 text-[12px] font-medium",
          tab === "channel" ? "bg-accent-soft text-ink" : "text-muted hover:bg-canvas",
        )}
      >
        Channel
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={tab === "devices"}
        onClick={() => setTab("devices")}
        className={cx(
          "min-h-8 rounded px-2.5 text-[12px] font-medium",
          tab === "devices" ? "bg-accent-soft text-ink" : "text-muted hover:bg-canvas",
        )}
      >
        Devices
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={tab === "bridge"}
        onClick={() => setTab("bridge")}
        className={cx("min-h-8 rounded px-2.5 text-[12px] font-medium", tab === "bridge" ? "bg-accent-soft text-ink" : "text-muted hover:bg-canvas")}
      >
        Bridge
      </button>
    </div>
  )

  if (tab === "bridge") {
    return (
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-md border border-line bg-surface p-4 shadow-lg">
          <Dialog.Title className="text-[15px] font-semibold">Settings</Dialog.Title>
          <Dialog.Description className="mt-1 text-[12px] text-muted">Signal delivery for #{channel.name}.</Dialog.Description>
          {tabs}
          <BridgeSettings channelId={channel.id} />
          <div className="mt-4 flex justify-end"><Dialog.Close type="button" className={buttonClass}>Close</Dialog.Close></div>
        </Dialog.Content>
      </Dialog.Portal>
    )
  }

  if (tab === "devices") {
    return (
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-md border border-line bg-surface p-4 shadow-lg">
          <Dialog.Title className="text-[15px] font-semibold">Settings</Dialog.Title>
          <Dialog.Description className="mt-1 text-[12px] text-muted">
            Manage paired phones and LAN sessions.
          </Dialog.Description>
          {tabs}
          <div className="mt-3">
            <DevicesPanel />
          </div>
          <div className="mt-4 flex justify-end">
            <Dialog.Close type="button" className={buttonClass}>
              Close
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    )
  }

  return (
    <Shell
      title="Channel settings"
      description={`Settings for #${channel.name}`}
      onSubmit={submit}
      submitLabel="Save"
      busy={busy}
      formError={formError}
    >
      {tabs}
      <Field label="Topic" help="Short line shown under the channel name.">
        {({ id, describedBy }) => (
          <input
            id={id}
            aria-describedby={describedBy || undefined}
            value={topic}
            onChange={(event) => setTopic(event.target.value)}
            className={inputClass}
          />
        )}
      </Field>
      <Field label="Repository path" help="Local git repository that write runs in this channel work on." error={repoError}>
        {({ id, describedBy }) => (
          <input
            id={id}
            aria-describedby={describedBy || undefined}
            aria-invalid={repoError ? true : undefined}
            value={repoPath}
            onChange={(event) => setRepoPath(event.target.value)}
            className={`${inputClass} font-mono`}
            placeholder="/home/you/code/project"
          />
        )}
      </Field>
      <Field label="Test command" help="Runs in the run's worktree to verify a write run, for example go test ./...">
        {({ id, describedBy }) => (
          <input
            id={id}
            aria-describedby={describedBy || undefined}
            value={testCommand}
            onChange={(event) => setTestCommand(event.target.value)}
            className={`${inputClass} font-mono`}
            placeholder="go test ./..."
          />
        )}
      </Field>
      <Field label="Default agent" help="Answers plain messages that mention nobody. Messages starting with / are not sent to it.">
        {({ id, describedBy }) => (
          <select
            id={id}
            aria-describedby={describedBy || undefined}
            value={defaultAgent}
            onChange={(event) => setDefaultAgent(event.target.value)}
            className={inputClass}
          >
            <option value="">None</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.display_name}
              </option>
            ))}
          </select>
        )}
      </Field>
      <div>
        <p className="text-[13px] font-medium text-ink">Lane preferences</p>
        {Object.keys(channel.lane_overrides ?? {}).length === 0 ? (
          <p className="text-[12px] text-muted">None. Set one with /lane &lt;persona&gt; &lt;lane&gt; in this channel.</p>
        ) : (
          <>
            <ul className="mt-1 space-y-0.5 font-mono text-[12px] text-ink">
              {Object.entries(channel.lane_overrides ?? {}).map(([handle, lane]) => (
                <li key={handle}>
                  @{handle}: {lane}
                </li>
              ))}
            </ul>
            <p className="text-[12px] text-muted">Clear one with /lane &lt;persona&gt; default.</p>
          </>
        )}
      </div>
    </Shell>
  )
}

function BridgeSettings({ channelId }: { channelId: string }) {
  const qc = useQueryClient()
  const queryKey = ["bridge-bindings", channelId]
  const bindings = useQuery({ queryKey, queryFn: () => api.bridgeBindings(channelId) })
  const [error, setError] = useState("")
  const [busy, setBusy] = useState("")
  async function update(binding: BridgeBinding, policy: BridgeBinding["outbound_agents"]) {
    setBusy(binding.conversation)
    setError("")
    try {
      const next = await api.patchBridgeBinding(channelId, binding.conversation, policy)
      qc.setQueryData<BridgeBinding[]>(queryKey, (list = []) => list.map((item) => item.conversation === next.conversation ? next : item))
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy("")
    }
  }
  return (
    <section aria-label="Signal bridge settings" className="mt-3">
      {bindings.isLoading && <p className="text-[12px] text-muted">Loading bindings...</p>}
      {bindings.isError && <p role="alert" className="text-[12px] text-danger">{errorText(bindings.error)}</p>}
      {bindings.data?.length === 0 && <p className="text-[12px] text-muted">No Signal conversations are bound to this channel.</p>}
      {bindings.data?.map((binding) => (
        <label key={binding.conversation} className="mt-3 block text-[13px]">
          {binding.recipients}
          <select
            aria-label={`Agent messages to ${binding.recipients}`}
            className={inputClass}
            disabled={busy !== ""}
            value={binding.outbound_agents}
            onChange={(event) => void update(binding, event.target.value as BridgeBinding["outbound_agents"])}
          >
            <option value="send">Send automatically</option>
            <option value="draft">Ask before sending</option>
            <option value="off">Do not send</option>
          </select>
        </label>
      ))}
      {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
    </section>
  )
}

export function CreateChannelDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (channel: Channel) => void
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      {open && <CreateForm onCreated={onCreated} onDone={() => onOpenChange(false)} />}
    </Dialog.Root>
  )
}

function CreateForm({ onCreated, onDone }: { onCreated: (channel: Channel) => void; onDone: () => void }) {
  const qc = useQueryClient()
  const [name, setName] = useState("")
  const [topic, setTopic] = useState("")
  const [repoPath, setRepoPath] = useState("")
  const [busy, setBusy] = useState(false)
  const [nameError, setNameError] = useState<string | null>(null)
  const [repoError, setRepoError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const members = useMembers()
  const agents = (members.data ?? []).filter((member) => member.kind === "agent")
  // Track the unticked ones so every agent starts ticked, even when the list loads late.
  const [unticked, setUnticked] = useState<Set<string>>(new Set())
  const [chosenDefault, setChosenDefault] = useState("")
  const ticked = agents.filter((agent) => !unticked.has(agent.id))
  const defaultId = ticked.some((agent) => agent.id === chosenDefault) ? chosenDefault : (ticked[0]?.id ?? "")

  function toggleAgent(id: string) {
    setUnticked((current) => {
      const next = new Set(current)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }

  async function submitMembers(): Promise<{ member_ids?: string[] }> {
    if (ticked.length === 0 && agents.length === 0) return {}
    // The server keeps member_ids as given, so the creator has to be in the list.
    const meId = (await qc.fetchQuery({ queryKey: qk.me, queryFn: () => api.me(), staleTime: 60_000 })).id
    return { member_ids: [meId, ...ticked.map((agent) => agent.id)] }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    const trimmed = name.trim()
    setNameError(null)
    setRepoError(null)
    setFormError(null)
    if (!CHANNEL_NAME_RE.test(trimmed)) {
      setNameError("Use lowercase letters, digits and dashes, for example team-notes.")
      return
    }
    setBusy(true)
    void submitMembers()
      .then((ids) =>
        api.createChannel({
          name: trimmed,
          kind: "team",
          visibility: "public",
          ...(topic.trim() ? { topic: topic.trim() } : {}),
          ...(repoPath.trim() ? { repo_path: repoPath.trim() } : {}),
          ...ids,
        }),
      )
      .then(async (created) => {
        // Creation does not take a default agent; set it right after. A failure here
        // leaves a working channel, and the settings dialog can still set it.
        if (!defaultId) return created
        try {
          return await api.patchChannel(created.id, { default_agent_id: defaultId })
        } catch {
          return created
        }
      })
      .then(
        (channel) => {
          qc.setQueryData<Channel[]>(qk.channels, (list = []) => replaceById(list, channel))
          setBusy(false)
          onDone()
          onCreated(channel)
        },
        (error: unknown) => {
          setBusy(false)
          const message = errorText(error)
          if (error instanceof ApiError && /repo_path|git|repo/i.test(message)) setRepoError(message)
          else if (error instanceof ApiError && /name/i.test(message)) setNameError(message)
          else setFormError(message)
        },
      )
  }

  return (
    <Shell
      title="Create channel"
      description="A channel is a shared room for people and agents."
      onSubmit={submit}
      submitLabel="Create"
      busy={busy}
      formError={formError}
    >
      <Field label="Name" help="Lowercase letters, digits and dashes." error={nameError}>
        {({ id, describedBy }) => (
          <input
            id={id}
            aria-describedby={describedBy || undefined}
            aria-invalid={nameError ? true : undefined}
            value={name}
            onChange={(event) => setName(event.target.value)}
            className={`${inputClass} font-mono`}
            placeholder="team-notes"
            autoComplete="off"
          />
        )}
      </Field>
      <Field label="Topic" help="Short line shown under the channel name.">
        {({ id, describedBy }) => (
          <input
            id={id}
            aria-describedby={describedBy || undefined}
            value={topic}
            onChange={(event) => setTopic(event.target.value)}
            className={inputClass}
          />
        )}
      </Field>
      {agents.length > 0 && (
        <>
          <fieldset className="mt-3">
            <div className="flex items-center gap-2">
              <legend className="flex-1 text-[13px] font-medium">Agents</legend>
              <button type="button" onClick={() => setUnticked(new Set())} className="min-h-8 rounded-md px-2 text-[12px] text-muted hover:bg-sidebar hover:text-ink">
                All
              </button>
              <button type="button" onClick={() => setUnticked(new Set(agents.map((agent) => agent.id)))} className="min-h-8 rounded-md px-2 text-[12px] text-muted hover:bg-sidebar hover:text-ink">
                None
              </button>
            </div>
            <ul className="mt-1 grid max-h-40 gap-0.5 overflow-y-auto sm:grid-cols-2">
              {agents.map((agent) => (
                <li key={agent.id}>
                  <label className="flex min-h-9 cursor-pointer items-center gap-2 rounded-md px-2 text-[13px] hover:bg-sidebar">
                    <input type="checkbox" checked={!unticked.has(agent.id)} onChange={() => toggleAgent(agent.id)} className="h-4 w-4" />
                    <span className="min-w-0 truncate">{agent.display_name}</span>
                    <span className="min-w-0 truncate text-[12px] text-faint">@{agent.handle}</span>
                  </label>
                </li>
              ))}
            </ul>
            <p className="mt-1 text-[12px] text-muted">Only members can be mentioned and answer here.</p>
          </fieldset>
          <Field label="Default agent" help="Answers messages that mention nobody.">
            {({ id, describedBy }) => (
              <select
                id={id}
                aria-describedby={describedBy || undefined}
                value={defaultId}
                onChange={(event) => setChosenDefault(event.target.value)}
                disabled={ticked.length === 0}
                className={inputClass}
              >
                {ticked.length === 0 && <option value="">None</option>}
                {ticked.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.display_name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </>
      )}
      <Field
        label="Repository path (optional)"
        help="Local git repository that write runs in this channel work on."
        error={repoError}
      >
        {({ id, describedBy }) => (
          <input
            id={id}
            aria-describedby={describedBy || undefined}
            aria-invalid={repoError ? true : undefined}
            value={repoPath}
            onChange={(event) => setRepoPath(event.target.value)}
            className={`${inputClass} font-mono`}
            placeholder="/home/you/code/project"
          />
        )}
      </Field>
    </Shell>
  )
}

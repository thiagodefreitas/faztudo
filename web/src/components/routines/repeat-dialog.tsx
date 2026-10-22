import * as Dialog from "@radix-ui/react-dialog"
import { useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { api } from "../../api/client"
import { qk } from "../../state/keys"
import type { Routine } from "../../types"
import { nextRun, SCHEDULE_PRESETS } from "./schedule"

const FIELD = "mt-1 min-h-10 w-full rounded border border-line bg-canvas px-2 text-[13px] md:min-h-8"
const CUSTOM = "custom"

// The Director's time zone is the one the browser runs in; the daemon runs
// routines in routines.timezone, which is the machine's zone unless set.
function zoneName(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

function nextText(cron: string, now: Date): string {
  const next = nextRun(cron, now)
  if (!next) return "Could not work out the next run. The daemon checks the expression when you save."
  const when = next.toLocaleString([], { weekday: "long", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
  return `Next run: ${when} (${zoneName()})`
}

// "Repeat this" turns the request of a finished run into a routine kept in the
// database, so it can run on a schedule without editing lanes.toml.
export function RepeatDialog({
  request,
  persona,
  channel,
  open,
  onOpenChange,
}: {
  request: string
  persona: string
  channel: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const qc = useQueryClient()
  const [name, setName] = useState(() => (request.split("\n")[0] ?? "").slice(0, 60))
  const [prompt, setPrompt] = useState(request)
  const [preset, setPreset] = useState<string>(SCHEDULE_PRESETS[0].id)
  const [custom, setCustom] = useState("0 9 * * 1-5")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState<Routine | null>(null)

  const cron = preset === CUSTOM ? custom.trim() : (SCHEDULE_PRESETS.find((item) => item.id === preset)?.cron ?? "")
  const ready = name.trim() !== "" && prompt.trim() !== "" && cron !== ""

  async function save() {
    setError(null)
    setBusy(true)
    try {
      const routine = await api.createRoutine({ name: name.trim(), prompt: prompt.trim(), persona, channel, schedule: cron })
      setSaved(routine)
      await qc.invalidateQueries({ queryKey: qk.routines })
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the routine.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/40" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-[10vh] z-50 flex max-h-[80vh] w-[min(32rem,calc(100vw-1.5rem))] -translate-x-1/2 flex-col overflow-hidden rounded-lg border border-line bg-surface shadow-lg"
        >
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <Dialog.Title className="text-[14px] font-semibold">Repeat this</Dialog.Title>
            <Dialog.Close className="min-h-10 rounded px-2 text-[13px] text-muted hover:text-ink md:min-h-8">Close</Dialog.Close>
          </div>
          {saved ? (
            <div className="space-y-3 p-4 text-[13px]">
              <p role="status">
                Created {saved.name}. It runs as @{saved.persona} in #{saved.channel}.
              </p>
              <Link to="/routines" onClick={() => onOpenChange(false)} className="font-medium text-accent hover:underline">
                Open routines
              </Link>
            </div>
          ) : (
            <form
              className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4"
              onSubmit={(event) => {
                event.preventDefault()
                if (ready && !busy) void save()
              }}
            >
              <label className="block text-[12px] text-muted">
                Name
                <input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} className={FIELD} />
              </label>
              <label className="block text-[12px] text-muted">
                Request
                <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={4} className={`${FIELD} py-1`} />
              </label>
              <p className="text-[12px] text-muted">
                Runs as <span className="font-medium text-ink">@{persona}</span> in <span className="font-medium text-ink">#{channel}</span>.
              </p>
              <label className="block text-[12px] text-muted">
                Schedule
                <select value={preset} onChange={(event) => setPreset(event.target.value)} className={FIELD}>
                  {SCHEDULE_PRESETS.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                  <option value={CUSTOM}>Custom cron expression</option>
                </select>
              </label>
              {preset === CUSTOM && (
                <label className="block text-[12px] text-muted">
                  Cron expression
                  <input value={custom} onChange={(event) => setCustom(event.target.value)} className={`${FIELD} font-mono`} />
                </label>
              )}
              <p className="text-[12px] text-muted" data-testid="repeat-next">
                {cron ? nextText(cron, new Date()) : "Enter a cron expression."}
              </p>
              {error && (
                <p role="alert" className="text-[13px] text-danger">
                  {error}
                </p>
              )}
              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={!ready || busy}
                  className="min-h-10 rounded bg-accent px-4 text-[13px] font-medium text-white disabled:opacity-50 md:min-h-8"
                >
                  Create routine
                </button>
              </div>
            </form>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

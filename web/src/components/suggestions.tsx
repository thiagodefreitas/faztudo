import { useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { api } from "../api/client"
import { cx } from "../lib/cx"
import { relativeTime } from "../lib/inbox"
import { qk } from "../state/keys"
import { replaceById } from "../state/merge"
import { useNow } from "../state/now"
import { useChannels, useMe, useSuggestions } from "../state/queries"
import type { Suggestion } from "../types"
import { Markdown } from "./markdown"

/** The longest dismissal reason the daemon takes, in characters. */
const REASON_MAX = 400
const SMALL = "min-h-10 rounded px-2 text-[12px] disabled:opacity-50 md:min-h-8"

function isLink(evidence: string): boolean {
  return /^https?:\/\/\S+$/i.test(evidence)
}

// What the scout found, waiting for the Director. Nothing here acts by itself:
// Make a task puts a task in Todo, Dismiss closes it, and a reason given on
// dismissal also teaches the scout a lesson. Nothing is shown when there is
// nothing open.
export function SuggestionsSection() {
  const suggestions = useSuggestions()
  const me = useMe()
  const open = (suggestions.data ?? []).filter((item) => item.state === "open").sort((a, b) => b.created_at.localeCompare(a.created_at))
  if (me.data?.kind === "agent" || open.length === 0) return null
  return (
    <section aria-label="Suggestions" className="border-t border-line">
      <h2 className="px-3 pb-1 pt-3 text-[12px] font-semibold uppercase tracking-wide text-muted">Suggestions ({open.length})</h2>
      <ul>
        {open.map((item) => (
          <SuggestionRow key={item.id} suggestion={item} />
        ))}
      </ul>
    </section>
  )
}

function SuggestionRow({ suggestion }: { suggestion: Suggestion }) {
  const qc = useQueryClient()
  const now = useNow()
  const channels = useChannels()
  const [expanded, setExpanded] = useState(false)
  const [dismissing, setDismissing] = useState(false)
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const channel = channels.data?.find((item) => item.id === suggestion.channel_id)
  const reasonLength = [...reason.trim()].length

  async function resolve(action: () => Promise<Suggestion>, failure: string) {
    setBusy(true)
    setError(null)
    try {
      const next = await action()
      qc.setQueryData<Suggestion[] | undefined>(qk.suggestions, (current) => (current ? replaceById(current, next) : current))
      void qc.invalidateQueries({ queryKey: qk.tasks })
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : failure)
      setBusy(false)
    }
  }

  return (
    <li className="border-b border-line" data-suggestion={suggestion.id}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="flex min-h-14 w-full items-center gap-3 px-3 py-2 text-left hover:bg-sidebar"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] font-medium">{suggestion.title}</span>
          <span className="block truncate text-[12px] text-muted">
            @{suggestion.persona}
            {channel ? ` in #${channel.name}` : ""}
          </span>
        </span>
        <time className="shrink-0 text-[11px] text-faint" dateTime={suggestion.created_at}>
          {relativeTime(suggestion.created_at, now)}
        </time>
      </button>
      {expanded && (
        <div className="space-y-3 px-3 pb-3">
          {suggestion.detail && (
            <div className="text-[13px]">
              <Markdown text={suggestion.detail} />
            </div>
          )}
          {suggestion.evidence.length > 0 && (
            <ul aria-label="Evidence" className="space-y-1 text-[12px]">
              {suggestion.evidence.map((item) => (
                <li key={item} className="min-w-0 break-words">
                  {isLink(item) ? (
                    <a href={item} target="_blank" rel="noreferrer noopener" className="text-accent underline">
                      {item}
                    </a>
                  ) : (
                    <code className="font-mono text-muted">{item}</code>
                  )}
                </li>
              ))}
            </ul>
          )}
          {error && (
            <p role="alert" className="text-[12px] text-danger">
              {error}
            </p>
          )}
          {dismissing ? (
            <div className="space-y-2">
              <label className="block text-[12px] text-muted">
                Why not? (optional)
                <input
                  value={reason}
                  maxLength={REASON_MAX}
                  onChange={(event) => setReason(event.target.value)}
                  className="mt-1 min-h-10 w-full rounded border border-line bg-canvas px-2 text-[13px] text-ink md:min-h-8"
                />
              </label>
              <p className="text-[12px] text-muted">
                A reason also teaches @{suggestion.persona}: it becomes the lesson &quot;Do not suggest: ...&quot; for #{channel?.name ?? "this channel"}, so the scout learns.
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={busy || reasonLength > REASON_MAX}
                  onClick={() => void resolve(() => api.dismissSuggestion(suggestion.id, { reason: reason.trim() }), "Could not dismiss the suggestion.")}
                  className={cx(SMALL, "bg-ink text-canvas")}
                >
                  Dismiss
                </button>
                <button type="button" disabled={busy} onClick={() => setDismissing(false)} className={cx(SMALL, "text-muted hover:text-ink")}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="flex gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void resolve(() => api.acceptSuggestion(suggestion.id), "Could not make a task.")}
                className={cx(SMALL, "bg-accent text-canvas")}
              >
                Make a task
              </button>
              <button type="button" disabled={busy} onClick={() => setDismissing(true)} className={cx(SMALL, "border border-line text-muted hover:text-ink")}>
                Dismiss
              </button>
            </div>
          )}
        </div>
      )}
    </li>
  )
}

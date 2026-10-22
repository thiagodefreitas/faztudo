import { QueryClientContext } from "@tanstack/react-query"
import { type KeyboardEvent, useContext, useRef, useState, useSyncExternalStore } from "react"
import { api } from "../api/client"
import { approvalShortcut, approvalSummary, needsConfirm, optionLetter, outcomeText } from "../lib/approval"
import { suggestedApprovalRule } from "../lib/approval-rule"
import { cx } from "../lib/cx"
import { relativeTime } from "../lib/inbox"
import { OPEN_TEST_COMMAND_EVENT } from "../lib/channel-settings"
import { qk } from "../state/keys"
import { useNow } from "../state/now"
import type { Approval, Channel, Run } from "../types"
import { DiffPreview } from "./approvals/diff-preview"
import { FoldedText } from "./folded-text"
import { Markdown } from "./markdown"

const BUTTON = "min-h-11 rounded-md border px-4 text-[14px] md:min-h-9 md:px-3 md:text-[13px]"

function SignalDraftCard({ approval, onResolve, decider }: { approval: Approval; onResolve: (option: string, text?: string) => void; decider?: string | undefined }) {
  const draft = approval.signal_draft!
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(draft.text)
  if (approval.state !== "pending") return <DecidedLine approval={approval} decider={decider} />
  return (
    <article aria-label={approval.title} className="fz-rise mt-3 rounded-lg border border-l-2 border-line border-l-warn bg-canvas p-3">
      <h3 className="text-[14px] font-semibold">{approval.title}</h3>
      <p className="mt-2 text-[12px] text-muted">Recipients: {draft.recipients}</p>
      <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border border-line bg-surface p-2 text-[13px]">{draft.text}</pre>
      {draft.attachments?.map((item) => <p key={item.id} className="mt-1 text-[12px] text-muted">Attachment: {item.name}</p>)}
      {editing && (
        <label className="mt-3 block text-[12px]">
          Edit message
          <textarea aria-label="Edit message" className="mt-1 block min-h-28 w-full rounded border border-line bg-surface p-2 text-[13px]" value={text} onChange={(event) => setText(event.target.value)} />
        </label>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className={cx(BUTTON, "border-accent bg-accent text-canvas")} onClick={() => onResolve("send")}>Send</button>
        {editing ? (
          <button type="button" className={BUTTON} disabled={!text.trim()} onClick={() => onResolve("edit_send", text)}>Send edited text</button>
        ) : (
          <button type="button" className={BUTTON} onClick={() => setEditing(true)}>Edit and send</button>
        )}
        <button type="button" className={BUTTON} onClick={() => onResolve("dont_send")}>Don't send</button>
      </div>
    </article>
  )
}

// The folded card: what was decided, by whom and when.
function DecidedLine({ approval, decider }: { approval: Approval; decider: string | undefined }) {
  const now = useNow()
  const when = approval.resolution ? relativeTime(approval.resolution.at, now) : ""
  return (
    <article aria-label={approval.title} className="fz-rise mt-3 rounded-lg border border-l-2 border-line border-l-ok bg-canvas px-3 py-2">
      <p className="flex flex-wrap items-baseline gap-x-1.5 text-[13px] text-muted">
        <span className="font-medium text-ink">{outcomeText(approval)}</span>
        {decider && <span>by {decider}</span>}
        {when && <span>{when === "now" ? "just now" : `${when} ago`}</span>}
      </p>
    </article>
  )
}

/**
 * One approval. A pending card leads with a one-line summary, then the
 * changed files, the check result, the commit message and the options. A
 * decided card folds to one line. `run`, `agentName` and `diff` are optional
 * context; without them the card still shows the title, detail and options.
 */
export function ApprovalCard({
  approval,
  onResolve,
  run,
  testCommand,
  agentName,
  agentHandle,
  diff,
  decider,
}: {
  approval: Approval
  onResolve: (option: string, commitMessage?: string) => void
  run?: Run | undefined
  testCommand?: string | undefined
  agentName?: string | undefined
  agentHandle?: string | undefined
  /** The run's diff, when it is known. */
  diff?: string | undefined
  /** Who decided, for a decided card. */
  decider?: string | undefined
}) {
  const [message, setMessage] = useState(approval.commit_message ?? "")
  const queryClient = useContext(QueryClientContext)
  const cachedChannels = useSyncExternalStore(
    (listen) => queryClient?.getQueryCache().subscribe(listen) ?? (() => undefined),
    () => queryClient?.getQueryData<Channel[]>(qk.channels),
    () => undefined,
  )
  const cachedChannel = cachedChannels?.find((item) => item.id === approval.channel_id)
  const commandKnown = testCommand !== undefined || cachedChannel !== undefined
  const channelTestCommand = testCommand ?? cachedChannel?.test_command
  const [confirming, setConfirming] = useState<string | null>(null)
  const [ruleOpen, setRuleOpen] = useState(false)
  const [ruleAnyAgent, setRuleAnyAgent] = useState(false)
  const [ruleError, setRuleError] = useState("")
  const [ruleBusy, setRuleBusy] = useState(false)
  const suggested = suggestedApprovalRule(diff ?? "", run?.diff_stat?.insertions ?? 0, run?.diff_stat?.deletions ?? 0)
  const [rulePaths, setRulePaths] = useState<string | null>(null)
  const [ruleMaxLines, setRuleMaxLines] = useState<number | null>(null)
  const cardRef = useRef<HTMLElement>(null)
  const messageRef = useRef<HTMLTextAreaElement>(null)
  const pending = approval.state === "pending"
  const write = approval.commit_message !== undefined
  const summary = approvalSummary(approval, run, agentName)

  function resolve(option: string) {
    setConfirming(null)
    // Only Merge uses the message, so Keep and Discard send the plain option.
    if (option === "merge" && write) onResolve(option, message)
    else onResolve(option)
  }

  function cancelConfirm() {
    setConfirming(null)
    cardRef.current?.focus()
  }

  async function saveRule() {
    if (!run || ruleBusy) return
    setRuleBusy(true)
    setRuleError("")
    try {
      await api.createApprovalRule({ channel_id: approval.channel_id, persona: ruleAnyAgent ? "" : (agentHandle ?? ""), paths: (rulePaths ?? suggested.paths.join("\n")).split("\n").map((value) => value.trim()).filter(Boolean), max_lines: ruleMaxLines ?? suggested.maxLines })
      setRuleOpen(false)
      onResolve("merge", message)
    } catch (error) {
      setRuleError(error instanceof Error ? error.message : "Could not save rule")
    } finally {
      setRuleBusy(false)
    }
  }

  // A danger option asks once more; its key again confirms it.
  function choose(option: string) {
    if (needsConfirm(approval, option)) setConfirming(option)
    else resolve(option)
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.target !== event.currentTarget || event.ctrlKey || event.metaKey || event.altKey) return
    const shortcut = approvalShortcut(approval, event.key)
    if (!shortcut) return
    event.preventDefault()
    if (shortcut.kind === "edit") messageRef.current?.focus()
    else choose(shortcut.option)
  }

  if (approval.signal_draft) return <SignalDraftCard approval={approval} onResolve={onResolve} decider={decider} />
  if (!pending) return <DecidedLine approval={approval} decider={decider} />

  const confirmLabel = approval.options.find((option) => option.key === confirming)?.label

  return (
    <article
      ref={cardRef}
      aria-label={approval.title}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="fz-rise mt-3 flex flex-col rounded-lg border border-l-2 border-line border-l-warn bg-canvas p-3 outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      <h3 data-testid="approval-summary" className="text-[14px] font-semibold">
        {summary}
      </h3>
      {write ? (
        <details className="mt-1">
          <summary className="inline-flex min-h-8 cursor-pointer items-center text-[12px] text-muted hover:text-ink">What this decides</summary>
          <div className="text-[13px]">
            <Markdown text={approval.detail} />
          </div>
        </details>
      ) : (
        <div className="mt-1 text-[13px]">
          <Markdown text={approval.detail} />
        </div>
      )}
      {/* The actions come first in the DOM so Tab order matches what a phone draws; md:order-* puts the diff and checks above them on wide screens. */}
      {confirming ? (
        <div
          role="alertdialog"
          aria-label={`Confirm ${confirmLabel ?? "choice"}`}
          onKeyDown={(event) => {
            const same = approvalShortcut(approval, event.key)
            if (event.key === "Escape") cancelConfirm()
            else if (same?.kind === "option" && same.option === confirming) resolve(confirming)
            else return
            event.preventDefault()
            event.stopPropagation()
          }}
          className="mt-3 rounded-md border border-danger bg-danger-soft p-2 md:order-2"
        >
          <p className="text-[13px]">
            {confirming === "discard" ? "Discard this change? The branch and its worktree are removed." : `${confirmLabel ?? "This choice"}? This cannot be undone.`}
          </p>
          <div className="mt-2 flex gap-2">
            <button type="button" onClick={() => resolve(confirming)} className={cx(BUTTON, "border-danger bg-danger text-canvas")}>
              Yes, {(confirmLabel ?? "continue").toLowerCase()}
            </button>
            {/* Cancel takes focus: a stray Enter must not destroy work. */}
            <button type="button" autoFocus onClick={cancelConfirm} className={cx(BUTTON, "border-line bg-surface")}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2 md:order-2">
          {approval.options.map((option, index) => (
            <button
              key={option.key}
              type="button"
              onClick={() => choose(option.key)}
              className={cx(
                BUTTON,
                option.style === "primary" && "border-accent bg-accent text-canvas",
                option.style === "danger" && "border-danger text-danger",
                !option.style && "border-line bg-surface",
              )}
            >
              <kbd className="mr-1.5 font-mono text-[12px] opacity-80">{write ? (optionLetter(option.key) ?? index + 1) : index + 1}</kbd>
              {option.label}
            </button>
          ))}
          {write && run && diff && agentHandle && <button type="button" onClick={() => setRuleOpen(true)} className={cx(BUTTON, "border-line bg-surface")}>Always merge changes like this here</button>}
        </div>
      )}
      <div className="md:order-1">{diff ? <DiffPreview diff={diff} /> : write && run?.diff_stat && <p className="mt-2 text-[12px] text-muted">Loading the changed files...</p>}</div>
      {run?.verification && (
        <div
          className={cx(
            "mt-3 rounded-md border-l-2 px-2.5 py-1.5 md:order-1",
            run.verification.ok ? "border-ok bg-ok-soft" : "border-danger bg-danger-soft",
          )}
        >
          <details open={!run.verification.ok}>
            <summary className="min-h-7 cursor-pointer text-[13px] font-medium">
              {run.verification.ok ? "Checks passed" : "Checks failed"}
            </summary>
            <FoldedText text={run.verification.detail} className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[12px] leading-5" />
          </details>
        </div>
      )}
      {write && run && !run.verification && commandKnown && !channelTestCommand?.trim() && <p className="mt-3 text-[12px] text-warn md:order-1">No checks ran. <a href={`/c/${encodeURIComponent(approval.channel_id)}#test-command`} className="text-accent underline" onClick={(click) => {
        const event = new CustomEvent(OPEN_TEST_COMMAND_EVENT, { detail: { channelId: approval.channel_id, handled: false } })
        window.dispatchEvent(event)
        if (event.detail.handled) click.preventDefault()
      }}>Set a test command in channel settings</a></p>}
      {write && (
        <label className="mt-3 block text-[12px] text-muted md:order-1">
          Commit message
          <textarea
            ref={messageRef}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return
              event.stopPropagation()
              cardRef.current?.focus()
            }}
            rows={4}
            spellCheck={false}
            className="mt-1 block w-full rounded-md border border-line bg-surface p-2 font-mono text-[12px] text-ink"
          />
        </label>
      )}
      {ruleOpen && run && <div role="dialog" aria-label="Create approval rule" className="mt-3 rounded-md border border-line bg-surface p-3 md:order-2">
        <p className="text-[13px] font-medium">Automatically merge future matching changes in this channel after checks pass.</p>
        <p className="mt-1 text-[12px] text-muted">Protected paths always require approval: .github/**, .gitlab-ci.yml, lefthook.yml, .pre-commit-config.yaml, Makefile, go.mod, go.sum, package.json, package-lock.json, *.lock, Dockerfile, scripts/**, .gitmodules, and .git/**. Executable changes and failed checks also require approval.</p>
        <label className="mt-2 flex items-center gap-2 text-[12px]"><input type="checkbox" checked={ruleAnyAgent} onChange={(event) => setRuleAnyAgent(event.target.checked)} />Any agent (otherwise {agentName ?? "this agent"})</label>
        <label className="mt-2 block text-[12px]">Allowed path globs, one per line<textarea aria-label="Allowed path globs" className="mt-1 w-full rounded border border-line bg-canvas p-2 font-mono" rows={3} value={rulePaths ?? suggested.paths.join("\n")} onChange={(event) => setRulePaths(event.target.value)} /></label>
        <label className="mt-2 block text-[12px]">Maximum changed lines<input aria-label="Maximum changed lines" type="number" min={1} max={2000} className="ml-2 w-24 rounded border border-line bg-canvas p-1" value={ruleMaxLines ?? suggested.maxLines} onChange={(event) => setRuleMaxLines(Number(event.target.value))} /></label>
        {ruleError && <p role="alert" className="mt-2 text-[12px] text-danger">{ruleError}</p>}
        <div className="mt-3 flex gap-2"><button type="button" disabled={ruleBusy} onClick={() => void saveRule()} className={cx(BUTTON, "border-accent bg-accent text-canvas")}>Save rule and merge</button><button type="button" onClick={() => setRuleOpen(false)} className={BUTTON}>Cancel</button></div>
      </div>}
      <p className="mt-2 hidden text-[12px] text-faint md:order-3 md:block">
        {write
          ? "With this card focused: m merges, k keeps, d discards, e edits the message."
          : `Keys 1-${Math.min(9, approval.options.length)} pick an option. Enter picks the first marked option.`}
      </p>
    </article>
  )
}

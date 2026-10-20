import { type KeyboardEvent, useRef, useState } from "react"
import { approvalShortcut, approvalSummary, needsConfirm, optionLetter, outcomeText } from "../lib/approval"
import { cx } from "../lib/cx"
import { relativeTime } from "../lib/inbox"
import { useNow } from "../state/now"
import type { Approval, Run } from "../types"
import { DiffPreview } from "./approvals/diff-preview"
import { FoldedText } from "./folded-text"
import { Markdown } from "./markdown"

const BUTTON = "min-h-11 rounded-md border px-4 text-[14px] md:min-h-9 md:px-3 md:text-[13px]"

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
  agentName,
  diff,
  decider,
}: {
  approval: Approval
  onResolve: (option: string, commitMessage?: string) => void
  run?: Run | undefined
  agentName?: string | undefined
  /** The run's diff, when it is known. */
  diff?: string | undefined
  /** Who decided, for a decided card. */
  decider?: string | undefined
}) {
  const [message, setMessage] = useState(approval.commit_message ?? "")
  const [confirming, setConfirming] = useState<string | null>(null)
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

  if (!pending) return <DecidedLine approval={approval} decider={decider} />

  const confirmLabel = approval.options.find((option) => option.key === confirming)?.label

  return (
    <article
      ref={cardRef}
      aria-label={approval.title}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="fz-rise mt-3 rounded-lg border border-l-2 border-line border-l-warn bg-canvas p-3 outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
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
      {diff ? <DiffPreview diff={diff} /> : write && run?.diff_stat && <p className="mt-2 text-[12px] text-muted">Loading the changed files...</p>}
      {run?.verification && (
        <div
          className={cx(
            "mt-3 rounded-md border-l-2 px-2.5 py-1.5",
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
      {write && (
        <label className="mt-3 block text-[12px] text-muted">
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
          className="mt-3 rounded-md border border-danger bg-danger-soft p-2"
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
        <div className="mt-3 flex flex-wrap gap-2">
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
        </div>
      )}
      <p className="mt-2 text-[12px] text-faint">
        {write
          ? "With this card focused: m merges, k keeps, d discards, e edits the message."
          : `Keys 1-${Math.min(9, approval.options.length)} pick an option. Enter picks the first marked option.`}
      </p>
    </article>
  )
}

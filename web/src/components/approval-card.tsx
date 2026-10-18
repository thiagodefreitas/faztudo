import { type KeyboardEvent, useState } from "react"
import { approvalKeyAction } from "../lib/approval"
import { cx } from "../lib/cx"
import type { Approval } from "../types"
import { Markdown } from "./markdown"

export function ApprovalCard({
  approval,
  onResolve,
}: {
  approval: Approval
  onResolve: (option: string, commitMessage?: string) => void
}) {
  const [message, setMessage] = useState(approval.commit_message ?? "")
  const pending = approval.state === "pending"
  const primary = approval.options.find((option) => option.style === "primary") ?? approval.options[0]
  const chosen = approval.options.find((option) => option.key === approval.resolution?.option)

  // Only Merge uses the message, so Keep and Discard send the plain option.
  function resolve(option: string) {
    if (option === "merge" && approval.commit_message !== undefined) onResolve(option, message)
    else onResolve(option)
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.target !== event.currentTarget) return
    const option = approvalKeyAction(approval, event.key)
    if (!option) return
    event.preventDefault()
    resolve(option)
  }

  return (
    <article
      aria-label={approval.title}
      tabIndex={pending ? 0 : undefined}
      onKeyDown={pending ? onKeyDown : undefined}
      className="fz-rise mt-3 rounded-lg border border-l-2 border-line border-l-warn bg-canvas p-3 outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      <h3 className="text-[14px] font-semibold">{approval.title}</h3>
      <div className="mt-1 text-[13px]">
        <Markdown text={approval.detail} />
      </div>
      {pending ? (
        <>
          {approval.commit_message !== undefined && (
            <label className="mt-3 block text-[12px] text-muted">
              Commit message
              <textarea
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                rows={6}
                spellCheck={false}
                className="mt-1 block w-full rounded-md border border-line bg-surface p-2 font-mono text-[12px] text-ink"
              />
            </label>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            {approval.options.map((option, index) => (
              <button
                key={option.key}
                type="button"
                onClick={() => resolve(option.key)}
                className={cx(
                  "min-h-11 rounded-md border px-4 text-[14px] md:min-h-9 md:px-3 md:text-[13px]",
                  option.style === "primary" && "border-accent bg-accent text-canvas",
                  option.style === "danger" && "border-danger text-danger",
                  !option.style && "border-line bg-surface",
                )}
              >
                {index + 1} {option.label}
              </button>
            ))}
          </div>
          <p className="mt-2 text-[12px] text-faint">
            Keys 1-{Math.min(9, approval.options.length)} pick an option. Enter picks {primary?.label ?? "the first option"}.
          </p>
        </>
      ) : (
        <p className="mt-2 text-[13px] text-muted">
          {approval.state === "expired"
            ? "Expired"
            : `Answered with ${chosen?.label ?? approval.resolution?.option ?? "an option"}`}
        </p>
      )}
    </article>
  )
}

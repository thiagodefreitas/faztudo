import type { KeyboardEvent } from "react"
import { approvalKeyAction } from "../lib/approval"
import { cx } from "../lib/cx"
import type { Approval } from "../types"
import { Markdown } from "./markdown"

export function ApprovalCard({
  approval,
  onResolve,
}: {
  approval: Approval
  onResolve: (option: string) => void
}) {
  const pending = approval.state === "pending"
  const primary = approval.options.find((option) => option.style === "primary") ?? approval.options[0]
  const chosen = approval.options.find((option) => option.key === approval.resolution?.option)

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.target !== event.currentTarget) return
    const option = approvalKeyAction(approval, event.key)
    if (!option) return
    event.preventDefault()
    onResolve(option)
  }

  return (
    <article
      aria-label={approval.title}
      tabIndex={pending ? 0 : undefined}
      onKeyDown={pending ? onKeyDown : undefined}
      className="mt-3 rounded-md border border-line bg-canvas p-3 outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      <h3 className="text-[14px] font-semibold">{approval.title}</h3>
      <div className="mt-1 text-[13px]">
        <Markdown text={approval.detail} />
      </div>
      {pending ? (
        <>
          <div className="mt-3 flex flex-wrap gap-2">
            {approval.options.map((option, index) => (
              <button
                key={option.key}
                type="button"
                onClick={() => onResolve(option.key)}
                className={cx(
                  "min-h-9 rounded-md border px-3 text-[13px]",
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

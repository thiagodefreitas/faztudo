import type { CatchUp, CatchUpLink } from "./catch-up"
import { catchUpSentences } from "./catch-up"

function Links({ label, links, onJump }: { label: string; links: CatchUpLink[]; onJump: (id: string) => void }) {
  if (links.length === 0) return null
  return (
    <ul aria-label={label} className="flex flex-wrap gap-1.5">
      {links.map((link, index) => (
        <li key={`${link.text}:${index}`}>
          {link.messageId ? (
            <button
              type="button"
              onClick={() => onJump(link.messageId as string)}
              className="min-h-8 rounded-full border border-line bg-canvas px-2.5 text-[12px] text-accent hover:underline md:min-h-6"
            >
              {link.text}
            </button>
          ) : (
            <span className="rounded-full border border-line px-2.5 py-0.5 text-[12px] text-muted">{link.text}</span>
          )}
        </li>
      ))}
    </ul>
  )
}

/** What happened since the reader left, in plain words. */
export function CatchUpCard({ data, onJump, onMarkRead }: { data: CatchUp; onJump: (id: string) => void; onMarkRead: () => void }) {
  return (
    <section aria-label="Catch up" className="my-1 flex flex-col gap-2 rounded-md border border-line bg-surface px-3 py-2 text-[13px]">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-medium text-ink">{catchUpSentences(data).join(" ")}</p>
          {data.summary && <p className="mt-0.5 text-muted">Earlier: {data.summary}</p>}
        </div>
        <button
          type="button"
          onClick={onMarkRead}
          className="min-h-8 shrink-0 rounded-md border border-line px-2.5 text-[12px] hover:bg-sidebar"
        >
          Mark read
        </button>
      </div>
      <Links label="Runs merged" links={data.merged} onJump={onJump} />
      <Links label="Runs failed" links={data.failed} onJump={onJump} />
      <Links label="Waiting on you" links={data.waiting} onJump={onJump} />
    </section>
  )
}

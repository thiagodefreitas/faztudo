import { fileUrl } from "../api/client"
import { formatSize, isInlineImage } from "../lib/files"
import type { Attachment } from "../types"

// Files on a message. Images show inline (the server only serves a few safe
// image types that way); every other file is a card that downloads.
export function AttachmentList({ attachments }: { attachments: Attachment[] | undefined }) {
  if (!attachments || attachments.length === 0) return null
  return (
    <ul className="mt-1 flex flex-wrap items-start gap-2" aria-label="Attachments">
      {attachments.map((attachment) => (
        <li key={attachment.id + attachment.name} className="min-w-0 max-w-full">
          {isInlineImage(attachment) ? (
            <a href={fileUrl(attachment)} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-lg border border-line">
              <img
                src={fileUrl(attachment)}
                alt={attachment.name}
                loading="lazy"
                className="block max-h-64 max-w-full object-contain"
              />
            </a>
          ) : (
            <a
              href={fileUrl(attachment)}
              download={attachment.name}
              className="flex min-h-10 max-w-72 items-center gap-2 rounded-lg border border-line bg-surface px-3 py-1.5 text-[13px] hover:bg-sidebar"
            >
              <svg viewBox="0 0 20 20" className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
                <path d="M5 2.5h6l4 4v11H5z" />
                <path d="M11 2.5v4h4" />
              </svg>
              <span className="min-w-0">
                <span className="block truncate font-medium text-ink">{attachment.name}</span>
                <span className="block text-[11px] text-faint">{formatSize(attachment.size)}</span>
              </span>
            </a>
          )}
        </li>
      ))}
    </ul>
  )
}

import type { Attachment } from "../types"

// The server only serves these inline; everything else is a download card.
const INLINE_IMAGES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])

export function isInlineImage(attachment: Pick<Attachment, "content_type">): boolean {
  return INLINE_IMAGES.has(attachment.content_type)
}

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return ""
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`
}

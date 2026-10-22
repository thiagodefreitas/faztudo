import { splitFiles } from "./diff"

export function suggestedApprovalRule(diff: string, insertions: number, deletions: number) {
  const paths = [...new Set(splitFiles(diff).map((file) => {
    const slash = file.path.lastIndexOf("/")
    return slash < 0 ? file.path : `${file.path.slice(0, slash)}/**`
  }))]
  return { paths, maxLines: Math.min(2000, Math.max(50, Math.ceil(((insertions + deletions) * 2) / 50) * 50)) }
}

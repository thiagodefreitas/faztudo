import type { NoticeItem } from "../types"

interface Rule {
  test: RegExp
  why: string
}

// The server words its notices from a handful of rules. Each entry names the
// rule that fired, in the order a notice is most likely to match.
const RULES: Rule[] = [
  {
    test: /was not moved to another lane|does not fall back|A \/lane override/i,
    why: "Fallback rule: a lane you name with /lane in a message is your choice, so faztudo never moves that run to another lane. It fails with the reason instead. Send the message without /lane to let the persona's lane order decide.",
  },
  {
    test: /Retrying @|Lane switched from|next run uses/i,
    why: "Fallback rule: when a run fails because its lane lost its login or plan, faztudo marks the lane unavailable and retries once on the next healthy lane in the persona's chain. The retry is a new run linked to the first one. Lanes recover on a probe or a successful run.",
  },
  {
    test: /although it is in conserve|in conserve/i,
    why: "Conserve rule: a lane above its conserve threshold is used last. When every lane in the chain is in conserve, the first one runs anyway.",
  },
  {
    test: /was skipped:/i,
    why: "Lane order: faztudo uses the first lane in the persona's chain that is healthy and has a free slot. Lanes that are exhausted, unavailable or busy are skipped, and the reason is shown here.",
  },
  {
    test: /is queued:|busy; it starts when/i,
    why: "Queue rule: each lane runs up to its capacity at once. A run that finds every lane in its chain busy waits and starts when a slot frees up.",
  },
  {
    test: /not assigned to (this )?project|did not run\./i,
    why: "Project rule: in a project's channels only the project lead, its assigned specialists and the members of its assigned departments run. The Director can assign the agent from the button or the Organization page.",
  },
  {
    test: /is not in @.+'s chain/i,
    why: "Lane check: /lane can only name a lane that is in the persona's chain in lanes.toml.",
  },
  {
    test: /Lane \S+ is (unavailable|exhausted)/i,
    why: "Lane health: a lane is marked unavailable on a login or plan error, and exhausted when its quota window is used up. It is skipped until it recovers.",
  },
  {
    test: /delegated runs|over budget/i,
    why: "Budget rule: one request may start a limited number of delegated runs, and fewer on premium lanes. Past that, the Director decides.",
  },
]

/** The rule behind a notice, or null when the notice is plain information. */
export function noticeWhy(notice: Pick<NoticeItem, "text" | "action">): string | null {
  for (const rule of RULES) if (rule.test.test(notice.text)) return rule.why
  if (notice.action?.kind === "assign") return RULES.find((rule) => rule.why.startsWith("Project rule"))?.why ?? null
  return null
}

import { useQueries, useQueryClient } from "@tanstack/react-query"
import { Link, getRouteApi } from "@tanstack/react-router"
import { useEffect, useRef, useState } from "react"
import { api } from "../../api/client"
import { approvalSummary, deciderName } from "../../lib/approval"
import { approvalRows, filterQuestions, filterRows, questionsWaiting, type ApprovalRow } from "../../lib/approval-inbox"
import { cx } from "../../lib/cx"
import { plainPreview, relativeTime } from "../../lib/inbox"
import { qk } from "../../state/keys"
import { replaceById } from "../../state/merge"
import { useNow } from "../../state/now"
import { useAllMessages, useApprovals, useChannels, useMembers, useOrg, useRunDiff, useRuns } from "../../state/queries"
import type { Approval, Message } from "../../types"
import { AgentAvatar } from "../agent-avatar"
import { ApprovalCard } from "../approval-card"
import { MessageChoices } from "../message-list"

const routeApi = getRouteApi("/approvals")

const SELECT = "min-h-10 rounded-md border border-line bg-surface px-2 text-[13px] md:min-h-8"

/** The card for one pending approval, with the run, diff and people it needs. */
export function ConnectedApproval({ approval }: { approval: Approval }) {
  const qc = useQueryClient()
  const runs = useRuns()
  const members = useMembers()
  const run = approval.run_id ? runs.data?.find((item) => item.id === approval.run_id) : undefined
  const agent = members.data?.find((item) => item.id === (run?.agent_id ?? approval.requested_by))
  const diff = useRunDiff(approval.run_id, approval.state === "pending" && approval.commit_message !== undefined)
  return (
    <ApprovalCard
      approval={approval}
      run={run}
      agentName={agent?.display_name}
      diff={diff.data?.diff}
      decider={deciderName(approval, members.data ?? [])}
      onResolve={(option, commitMessage) => {
        const body = commitMessage ? { option, commit_message: commitMessage } : { option }
        void api.resolveApproval(approval.id, body).then((next) => {
          qc.setQueryData<Approval[]>(qk.approvals, (list = []) => replaceById(list, next))
        })
      }}
    />
  )
}

function Row({ row, open, onToggle, now }: { row: ApprovalRow; open: boolean; onToggle: () => void; now: number }) {
  const ref = useRef<HTMLLIElement>(null)
  useEffect(() => {
    if (open) ref.current?.scrollIntoView?.({ block: "nearest" })
  }, [open])
  const { approval, agent, channel, project, run } = row
  return (
    <li ref={ref} data-approval={approval.id} className="px-3 py-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex min-h-11 w-full items-center gap-2 text-left md:min-h-9"
      >
        <AgentAvatar member={agent} size={28} decorative />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] font-medium">{approvalSummary(approval, run, agent?.display_name)}</span>
          <span className="block truncate text-[12px] text-muted">
            {project ? `${project.name} / ` : ""}#{channel?.name ?? "unknown"}
          </span>
        </span>
        <span className="shrink-0 font-mono text-[11px] text-faint">{relativeTime(run?.ended_at ?? run?.started_at, now)}</span>
      </button>
      {open && <ConnectedApproval approval={approval} />}
    </li>
  )
}

function QuestionRow({ message, channelName, agentName, now }: { message: Message; channelName: string; agentName: string; now: number }) {
  return (
    <li data-question={message.id} className="px-3 py-2">
      <p className="text-[14px] font-medium">{plainPreview(message.body) || "A question"}</p>
      <p className="text-[12px] text-muted">
        {agentName} in #{channelName} {relativeTime(message.created_at, now)}{" "}
        <Link to="/c/$channelId" params={{ channelId: message.channel_id }} className="text-accent hover:underline">
          Open channel
        </Link>
      </p>
      <MessageChoices message={message} channelId={message.channel_id} />
    </li>
  )
}

/**
 * Everything that waits for the human: write approvals and other approvals
 * oldest first, then questions an agent asked with options. `focus` is an
 * approval to open, set by a notification.
 */
export function ApprovalsInbox({ focus }: { focus?: string | undefined }) {
  const now = useNow()
  const approvals = useApprovals()
  const channels = useChannels()
  const members = useMembers()
  const org = useOrg()
  const runs = useRuns()
  const [project, setProject] = useState("")
  const [agent, setAgent] = useState("")
  // What the person toggled; a row nobody touched is open only if it is the focus.
  const [toggled, setToggled] = useState<Map<string, boolean>>(() => new Map())
  const isOpen = (id: string) => toggled.get(id) ?? id === focus

  const projects = org.data?.projects ?? []
  const people = members.data ?? []
  const channelList = channels.data ?? []
  const all = approvalRows(approvals.data ?? [], channelList, projects, runs.data ?? [], people)
  const filter = { ...(project ? { project } : {}), ...(agent ? { agent } : {}) }
  const rows = filterRows(all, filter)

  // A question is a message with options and no human answer in its thread.
  // Threads are only fetched for messages that have replies.
  const messages = useAllMessages(channelList.map((channel) => channel.id))
  const withOptions = messages.filter((message) => message.options && message.options.length > 0 && !message.thread_id)
  const threads = useQueries({
    queries: withOptions
      .filter((message) => (message.reply_count ?? 0) > 0)
      .map((message) => ({ queryKey: qk.thread(message.id), queryFn: () => api.thread(message.id) })),
  })
  const replies = new Map<string, Message[]>()
  for (const thread of threads) if (thread.data) replies.set(thread.data.root.id, thread.data.replies)
  const questions = filterQuestions(questionsWaiting(withOptions, replies, channelList, projects, people), filter)

  const agentsHere = people.filter((member) => member.kind === "agent")
  const total = all.length
  const nothing = rows.length === 0 && questions.length === 0

  function toggle(id: string) {
    setToggled((current) => new Map(current).set(id, !(current.get(id) ?? id === focus)))
  }

  return (
    <section aria-label="Approvals" className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-line px-3 py-2">
        <h1 className="text-[15px] font-semibold">Needs you</h1>
        <span className="font-mono text-[12px] text-muted">
          {total} {total === 1 ? "approval" : "approvals"}, {questions.length} {questions.length === 1 ? "question" : "questions"}
        </span>
        <div className="ml-auto flex gap-2">
          <select aria-label="Project" value={project} onChange={(event) => setProject(event.target.value)} className={SELECT}>
            <option value="">All projects</option>
            {projects.map((item) => (
              <option key={item.handle} value={item.handle}>
                {item.name}
              </option>
            ))}
          </select>
          <select aria-label="Agent" value={agent} onChange={(event) => setAgent(event.target.value)} className={SELECT}>
            <option value="">All agents</option>
            {agentsHere.map((item) => (
              <option key={item.id} value={item.id}>
                {item.display_name}
              </option>
            ))}
          </select>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {nothing && (
          <p className="rounded-lg border border-dashed border-line px-3 py-6 text-center text-[13px] text-muted">
            {total > 0 ? "Nothing matches these filters." : "Nothing needs you right now."}
          </p>
        )}
        {rows.length > 0 && (
          <section aria-label="Approvals waiting" className="mb-5">
            <h2 className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-faint">Approvals waiting</h2>
            <ul className={cx("divide-y divide-line rounded-lg border border-line bg-surface")}>
              {rows.map((row) => (
                <Row key={row.approval.id} row={row} now={now} open={isOpen(row.approval.id)} onToggle={() => toggle(row.approval.id)} />
              ))}
            </ul>
          </section>
        )}
        {questions.length > 0 && (
          <section aria-label="Questions waiting">
            <h2 className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-faint">Questions waiting</h2>
            <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
              {questions.map((question) => (
                <QuestionRow
                  key={question.message.id}
                  message={question.message}
                  channelName={question.channel?.name ?? "unknown"}
                  agentName={question.agent?.display_name ?? "An agent"}
                  now={now}
                />
              ))}
            </ul>
          </section>
        )}
      </div>
    </section>
  )
}

/** The /approvals route. */
export function ApprovalsPage() {
  const { a } = routeApi.useSearch()
  return <ApprovalsInbox focus={a} />
}

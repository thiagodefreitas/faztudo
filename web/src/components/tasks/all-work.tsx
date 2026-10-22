import { useNavigate } from "@tanstack/react-router"
import { useEffect, useMemo, useState } from "react"
import { groupWork, workUsage, WORK_COLUMNS, WORK_TITLES } from "../../lib/all-work"
import { formatAge, formatElapsed } from "../../lib/time"
import { useAllMessages, useMembers, useRuns } from "../../state/queries"
import type { Channel, Member, Run } from "../../types"
import { AgentAvatar } from "../agent-avatar"

const AVATAR_STATE: Partial<Record<Run["state"], "working" | "waiting">> = { running: "working", verifying: "working", waiting_approval: "waiting" }

// Runs of the last 24 hours in five columns. A card opens the run panel in its
// channel. It reads the runs and messages the rest of the app already loads.
export function AllWork({ channels, channelIds }: { channels: Channel[]; channelIds?: Set<string> }) {
  const runs = useRuns()
  const members = useMembers()
  const navigate = useNavigate()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])

  // The caller builds a new Set each render; the memo keys on its contents.
  const scopeKey = channelIds ? [...channelIds].sort().join(",") : undefined
  const scoped = useMemo(() => {
    const ids = scopeKey === undefined ? undefined : new Set(scopeKey.split(","))
    return (runs.data ?? []).filter((run) => !ids || ids.has(run.channel_id))
  }, [runs.data, scopeKey])
  // Messages are loaded only for channels with a run on the board.
  const runChannels = useMemo(() => {
    const ids = new Set<string>()
    for (const column of Object.values(groupWork(scoped, [], [], now))) for (const card of column) ids.add(card.run.channel_id)
    return [...ids].sort()
  }, [scoped, now])
  const messages = useAllMessages(runChannels)
  const people = useMemo<Member[]>(() => members.data ?? [], [members.data])
  const columns = useMemo(() => groupWork(scoped, messages, people, now), [scoped, messages, people, now])

  if (runs.isPending) return <p className="p-4 text-[13px] text-muted">Loading work</p>

  return (
    <div className="grid min-h-0 flex-1 gap-3 overflow-y-auto p-3 md:grid-cols-5 md:overflow-x-auto" data-testid="all-work">
      {WORK_COLUMNS.map((key) => (
        <section key={key} aria-label={WORK_TITLES[key]} className="flex min-w-0 flex-col gap-2 md:min-w-[180px]">
          <h2 className="flex items-center gap-2 text-[13px] font-semibold">
            {WORK_TITLES[key]}
            <span className="rounded-full border border-line px-2 text-[11px] font-normal text-muted">{columns[key].length}</span>
          </h2>
          {columns[key].length === 0 ? (
            <p className="text-[12px] text-muted">Nothing here.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {columns[key].map(({ run, request, from }) => {
                const agent = people.find((member) => member.id === run.agent_id)
                const channel = channels.find((item) => item.id === run.channel_id)
                const handle = agent?.handle ?? run.agent_id
                const finished = run.ended_at
                const when = finished
                  ? `${run.state === "done" ? "done" : run.state} ${formatAge(finished, now)}`
                  : run.started_at
                    ? formatElapsed(run.started_at, undefined, now)
                    : "waiting to start"
                return (
                  <li key={run.id}>
                    <button
                      type="button"
                      title={request || undefined}
                      onClick={() => void navigate({ to: "/c/$channelId", params: { channelId: run.channel_id }, search: { run: run.id } })}
                      className="block min-h-10 w-full min-w-0 rounded-md border border-line bg-surface p-2 text-left hover:bg-canvas"
                    >
                      <span className="flex items-center gap-1.5">
                        <AgentAvatar member={agent} size={20} state={AVATAR_STATE[run.state]} decorative />
                        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">@{handle}</span>
                        <span className="shrink-0 text-[12px] text-muted">{run.lane_id}</span>
                      </span>
                      <span className="mt-1 block truncate text-[13px]">{request || "Request not loaded"}</span>
                      <span className="mt-0.5 block truncate text-[12px] text-muted">
                        {channel ? `#${channel.name}` : "channel"} - {when}
                        {from ? ` - from @${from}` : ""}
                        {workUsage(run) ? ` - ${workUsage(run)}` : ""}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      ))}
    </div>
  )
}

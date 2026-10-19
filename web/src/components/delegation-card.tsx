import { Link } from "@tanstack/react-router"
import { cx } from "../lib/cx"
import { countPieces, delegationLine, delegationPieces, pieceLabel, type Piece, type PieceState } from "../lib/delegation"
import { formatElapsed } from "../lib/time"
import { useNow } from "../state/now"
import { useMembers, useRuns } from "../state/queries"
import type { Message } from "../types"
import { AgentAvatar, type AvatarState } from "./agent-avatar"

const CHIP: Record<PieceState, string> = {
  pending: "border-line text-muted",
  queued: "border-line text-muted",
  running: "border-accent bg-accent-soft text-accent",
  verifying: "border-accent bg-accent-soft text-accent",
  waiting_approval: "border-warn bg-warn-soft text-warn",
  done: "border-ok bg-ok-soft text-ok",
  failed: "border-danger bg-danger-soft text-danger",
  cancelled: "border-line text-faint",
}

const RING: Partial<Record<PieceState, AvatarState>> = {
  running: "working",
  verifying: "working",
  waiting_approval: "waiting",
  failed: "failed",
}

const LIVE = new Set<PieceState>(["queued", "running", "verifying", "waiting_approval"])

// Who has which piece of a request, in the thread panel. The pieces come from
// the handoff replies under the root and the runs they started, both kept
// current by the stream, so the card follows along without a request.
export function DelegationCard({ channelId, rootId, replies }: { channelId: string; rootId: string; replies: Message[] }) {
  const runs = useRuns()
  const members = useMembers()
  const pieces = delegationPieces(rootId, replies, runs.data ?? [], members.data ?? [])
  const line = delegationLine(countPieces(pieces))
  if (pieces.length === 0 || !line) return null
  return (
    <section aria-label="Delegation" className="fz-rise mt-2 rounded-lg border border-line bg-canvas px-2.5 py-2">
      <p className="text-[12px] font-medium text-ink">{line}</p>
      <ol className="mt-1.5 flex flex-col gap-1.5">
        {pieces.map((piece) => (
          <PieceRow key={piece.message.id} piece={piece} channelId={channelId} />
        ))}
      </ol>
    </section>
  )
}

function PieceRow({ piece, channelId }: { piece: Piece; channelId: string }) {
  const handle = piece.agent?.handle ?? piece.handoff.to
  return (
    <li className="flex min-w-0 items-start gap-2 text-[12px]">
      <AgentAvatar member={piece.agent} size={20} state={RING[piece.state]} decorative className="mt-px" />
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="font-medium text-ink">@{handle}</span>
          <span className={cx("rounded-full border px-1.5 py-px text-[11px] leading-4", CHIP[piece.state])} data-state={piece.state}>
            {pieceLabel(piece.state)}
          </span>
          {piece.run && <PieceElapsed piece={piece} />}
          {piece.run && (
            <Link
              to="/c/$channelId"
              params={{ channelId }}
              search={{ run: piece.run.id }}
              className="min-h-6 text-accent hover:underline"
              aria-label={`Open the run of @${handle}`}
            >
              Open run
            </Link>
          )}
        </p>
        {piece.task && <p className="truncate text-muted" title={piece.task}>{piece.task}</p>}
      </div>
    </li>
  )
}

// Only live pieces tick; a finished one reads its own start and end.
function PieceElapsed({ piece }: { piece: Piece }) {
  if (LIVE.has(piece.state)) return <LiveElapsed startedAt={piece.run?.started_at} />
  const ended = piece.run?.ended_at
  if (!ended) return null
  return <span className="font-mono tabular-nums text-faint">{formatElapsed(piece.run?.started_at, ended, 0)}</span>
}

function LiveElapsed({ startedAt }: { startedAt: string | undefined }) {
  const now = useNow()
  return <span className="font-mono tabular-nums text-faint">{formatElapsed(startedAt, undefined, now)}</span>
}

import type { ReactNode } from "react"
import { hueFor, identityOf, initialOf, type AvatarMember, type Cli, type Role } from "../lib/avatar"
import { cx } from "../lib/cx"

export type AvatarSize = 16 | 20 | 28 | 36 | 48 | 96
export type AvatarState = "working" | "waiting" | "failed" | "off"

export interface AvatarPerson extends AvatarMember {
  display_name: string
}

// All characters are our own. They share one tile, one eye style (two soft
// dots cut out of the head) and one stroke weight (2 units), and differ by
// silhouette so they can be told apart without color. `fill-current` paints
// with the hue foreground; `EYE` paints with the tile tint.
const EYE = "fill-[var(--fz-tile)]"
const STROKE = { strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", fill: "none", stroke: "currentColor" } as const

function Eyes({ y = 18, x1 = 12.5, x2 = 19.5 }: { y?: number; x1?: number; x2?: number }) {
  return (
    <g className="fz-av-eyes">
      <circle cx={x1} cy={y} r={2} className={EYE} />
      <circle cx={x2} cy={y} r={2} className={EYE} />
    </g>
  )
}

const CHARACTERS: Record<Cli | "unknown", () => ReactNode> = {
  // Round head, one antenna.
  claude: () => (
    <>
      <circle cx={16} cy={18} r={8.5} fill="currentColor" />
      <path d="M16 9.5V6" {...STROKE} />
      <circle cx={16} cy={5} r={2} fill="currentColor" />
      <Eyes />
    </>
  ),
  // Square-ish head with a visor band.
  codex: () => (
    <>
      <rect x={6.5} y={8.5} width={19} height={17} rx={5} fill="currentColor" />
      <rect x={9.5} y={14} width={13} height={7} rx={3.5} className={EYE} />
      <g className="fz-av-eyes">
        <circle cx={13} cy={17.5} r={1.5} fill="currentColor" />
        <circle cx={19} cy={17.5} r={1.5} fill="currentColor" />
      </g>
    </>
  ),
  // Round head with two pointed ears.
  agy: () => (
    <>
      <path d="M7.5 15 8 5.5 14 10.5ZM24.5 15 24 5.5 18 10.5Z" fill="currentColor" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" />
      <circle cx={16} cy={18.5} r={9} fill="currentColor" />
      <Eyes y={18.5} />
    </>
  ),
  // One big eye.
  kimi: () => (
    <>
      <circle cx={16} cy={16.5} r={9.5} fill="currentColor" />
      <circle cx={16} cy={16.5} r={4.5} className={EYE} />
      <circle cx={16} cy={16.5} r={2} fill="currentColor" className="fz-av-eyes" />
      <path d="M13 26.5h6" {...STROKE} />
    </>
  ),
  // Sharp square head with side bolts and a bracket mouth.
  opencode: () => (
    <>
      <rect x={7.5} y={7.5} width={17} height={17} rx={2.5} fill="currentColor" />
      <path d="M4.5 13v6M27.5 13v6" {...STROKE} />
      <Eyes y={14.5} />
      <path d="M12.5 20.5h7" className="stroke-[var(--fz-tile)]" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </>
  ),
  // Wide low head with two stubby antennae.
  grok: () => (
    <>
      <rect x={5.5} y={13} width={21} height={13} rx={6.5} fill="currentColor" />
      <path d="M11 13 9 7.5M21 13l2-5.5" {...STROKE} />
      <circle cx={8.8} cy={6.8} r={1.8} fill="currentColor" />
      <circle cx={23.2} cy={6.8} r={1.8} fill="currentColor" />
      <Eyes y={19.5} />
    </>
  ),
  // Neutral blob for an agent we know nothing about.
  unknown: () => (
    <>
      <rect x={7} y={8} width={18} height={18} rx={9} fill="currentColor" />
      <Eyes y={16.5} />
      <path d="M13.5 21.2q2.5 1.8 5 0" className="stroke-[var(--fz-tile)]" strokeWidth={1.6} strokeLinecap="round" fill="none" />
    </>
  ),
}

// Role badge, lower right corner, drawn inside a 12 unit disc.
const BADGES: Record<Role, () => ReactNode> = {
  coder: () => <path d="M23.2 23.7 21.4 25.5l1.8 1.8M27.8 23.7l1.8 1.8-1.8 1.8M26.6 22.8l-2.2 5.4" />,
  reviewer: () => (
    <>
      <circle cx={24.6} cy={24.6} r={2.5} />
      <path d="M26.5 26.5l2.3 2.3" />
    </>
  ),
  architect: () => (
    <>
      <path d="M25.5 22.4l-2.4 6.2M25.5 22.4l2.4 6.2M24 26.7h3" />
      <circle cx={25.5} cy={22.2} r={0.5} />
    </>
  ),
  writer: () => <path d="M28.6 22.4c-4.4 0-6.2 3-6.2 6.2 3.4-.2 6.2-2.2 6.2-6.2ZM22.4 28.6l2.4-2.6" />,
  other: () => <circle cx={25.5} cy={25.5} r={1.4} fill="currentColor" />,
}

const STATE_RING: Record<Exclude<AvatarState, "off">, string> = {
  working: "stroke-current",
  waiting: "stroke-warn",
  failed: "stroke-danger",
}

const STATE_LABEL: Record<AvatarState, string> = {
  working: "working",
  waiting: "waiting",
  failed: "failed",
  off: "off",
}

export function AgentAvatar({
  member,
  size = 28,
  state,
  decorative = false,
  className,
}: {
  member: AvatarPerson | null | undefined
  size?: AvatarSize
  state?: AvatarState | undefined
  // Set when a visible name sits next to the avatar.
  decorative?: boolean
  className?: string
}) {
  const name = member?.display_name ?? "Member"
  const a11y = decorative
    ? ({ "aria-hidden": true } as const)
    : ({ role: "img", "aria-label": state ? `${name}, ${STATE_LABEL[state]}` : name } as const)

  if (!member || member.kind !== "agent") {
    return (
      <span
        data-testid="avatar"
        {...a11y}
        style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
        className={cx(
          "inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold leading-none",
          hueFor(member).disc,
          className,
        )}
      >
        {initialOf(name)}
      </span>
    )
  }

  const identity = identityOf(member)
  const hue = hueFor(member)
  const Character = CHARACTERS[identity.cli ?? "unknown"]
  // The badge needs room to read, so the smallest size drops it.
  const badge = identity.role && size > 16 ? BADGES[identity.role] : undefined
  const ring = state && state !== "off" ? STATE_RING[state] : undefined
  return (
    <svg
      data-testid="avatar"
      data-cli={identity.cli ?? "unknown"}
      data-role={identity.role ?? undefined}
      viewBox="0 0 32 32"
      width={size}
      height={size}
      {...a11y}
      className={cx("shrink-0", hue.ink, state === "off" && "opacity-60 grayscale", state === "working" && "fz-av-working", className)}
      style={{ ["--fz-tile" as string]: `var(--color-agent-${identity.slot + 1}-soft)` }}
    >
      <rect width={32} height={32} rx={8} className={hue.tile} />
      <g className="fz-av-body">{Character()}</g>
      {badge && (
        // Scaled toward the corner so the disc and its stroke stay inside
        // the 32 unit tile instead of being clipped at the edges.
        <g transform="translate(24.9 24.9) scale(0.86) translate(-25.5 -25.5)">
          <circle cx={25.5} cy={25.5} r={6} className={cx(hue.tile, "stroke-current")} strokeWidth={1.5} />
          <g {...STROKE} strokeWidth={1.3}>
            {badge()}
          </g>
        </g>
      )}
      {ring && state === "working" && (
        <>
          <rect x={1} y={1} width={30} height={30} rx={7} fill="none" strokeWidth={2} className={cx(ring, "opacity-25")} />
          {/* A short arc that travels around the tile while the agent works. */}
          <rect
            x={1}
            y={1}
            width={30}
            height={30}
            rx={7}
            fill="none"
            strokeWidth={2}
            strokeLinecap="round"
            pathLength={100}
            strokeDasharray="22 78"
            className={cx(ring, "fz-av-orbit")}
          />
        </>
      )}
      {ring && state !== "working" && (
        <rect
          x={1}
          y={1}
          width={30}
          height={30}
          rx={7}
          fill="none"
          strokeWidth={2}
          // Dashed, so waiting differs from working by shape as well as color
          // (the codex hue is close to the warn color).
          strokeDasharray={state === "waiting" ? "4 3" : undefined}
          className={ring}
        />
      )}
    </svg>
  )
}

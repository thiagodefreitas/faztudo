# Design

This document defines the visual language, design tokens and user interface
rules for faztudo across the web chat, the Lanes dashboard, and the later 2D
and 3D office views.

Brand assets and CSS custom properties live under `assets/brand/`:

| file | purpose |
| :--- | :--- |
| `assets/brand/logo-mark.svg` | single-color geometric mark on a 32x32 grid |
| `assets/brand/logo.svg` | mark plus path wordmark for light surfaces |
| `assets/brand/logo-dark.svg` | mark plus path wordmark for dark surfaces |
| `assets/brand/favicon.svg` | mark with `prefers-color-scheme` support |
| `assets/brand/tokens.css` | CSS custom properties for light and dark themes |

## Brand mark

The mark represents the tagline: "Your agents and you, in one room."

- The outer contour is a rounded square room (`28x28` inside a `32x32`
  `viewBox`) with a sharp bottom-left corner (`rx="2"`) that reads as both a
  chat bubble tail and a room corner.
- Inside the room, negative-space cutouts form the letter `F` from two
  horizontal lanes alongside a square companion node (`4x4` at `20,16`).
- Every coordinate in the mark (`2, 8, 12, 16, 20, 24, 30`) is a multiple of 2,
  and every stroke or gap is at least 4 units wide. At `16x16` pixels, every
  edge lands on a whole pixel boundary and every bar or gap is at least 2
  pixels wide.
- All SVG files are hand-written paths with no embedded raster images and no
  `<text>` elements or external font dependencies.

## Palette and contrast

The palette uses cool slate neutrals and a single teal accent so that semantic
status signals (approvals, warnings, test failures, lane exhaustion) stand out
without visual noise.

WCAG 2.1 contrast ratios (minimum 4.5:1 for AA normal text, 7.0:1 for AAA):

| token pair | light theme | ratio (light) | dark theme | ratio (dark) |
| :--- | :--- | :--- | :--- | :--- |
| `--fz-text-primary` on `--fz-bg-canvas` | `#11181c` on `#f7f9fa` | 16.98:1 (AAA) | `#edf2f4` on `#0f1417` | 16.43:1 (AAA) |
| `--fz-text-primary` on `--fz-bg-surface` | `#11181c` on `#ffffff` | 17.93:1 (AAA) | `#edf2f4` on `#151c21` | 15.25:1 (AAA) |
| `--fz-text-primary` on `--fz-bg-subtle` | `#11181c` on `#eef2f5` | 15.93:1 (AAA) | `#edf2f4` on `#1c252b` | 13.80:1 (AAA) |
| `--fz-text-secondary` on `--fz-bg-canvas` | `#3f4d56` on `#f7f9fa` | 8.26:1 (AAA) | `#a8b6bf` on `#0f1417` | 8.92:1 (AAA) |
| `--fz-text-secondary` on `--fz-bg-subtle` | `#3f4d56` on `#eef2f5` | 7.75:1 (AAA) | `#a8b6bf` on `#1c252b` | 7.49:1 (AAA) |
| `--fz-text-muted` on `--fz-bg-canvas` | `#576670` on `#f7f9fa` | 5.62:1 (AA) | `#84949e` on `#0f1417` | 5.92:1 (AA) |
| `--fz-accent-text` on `--fz-bg-canvas` | `#0a635c` on `#f7f9fa` | 6.74:1 (AA) | `#5cd6c8` on `#0f1417` | 10.51:1 (AAA) |
| `--fz-accent-text` on `--fz-accent-subtle` | `#0a635c` on `#dff3f0` | 6.17:1 (AA) | `#5cd6c8` on `#102a29` | 8.60:1 (AAA) |
| `--fz-success-text` on `--fz-bg-canvas` | `#156839` on `#f7f9fa` | 6.48:1 (AA) | `#5dd98c` on `#0f1417` | 10.39:1 (AAA) |
| `--fz-success-text` on `--fz-success-subtle` | `#156839` on `#e3f5ea` | 6.03:1 (AA) | `#5dd98c` on `#11291c` | 8.67:1 (AAA) |
| `--fz-warn-text` on `--fz-bg-canvas` | `#8a4b08` on `#f7f9fa` | 6.43:1 (AA) | `#f5b942` on `#0f1417` | 10.51:1 (AAA) |
| `--fz-warn-text` on `--fz-warn-subtle` | `#8a4b08` on `#fef0db` | 6.05:1 (AA) | `#f5b942` on `#2b200d` | 9.05:1 (AAA) |
| `--fz-danger-text` on `--fz-bg-canvas` | `#b42318` on `#f7f9fa` | 6.23:1 (AA) | `#f97066` on `#0f1417` | 6.65:1 (AA) |
| `--fz-danger-text` on `--fz-danger-subtle` | `#b42318` on `#fde8e6` | 5.59:1 (AA) | `#f97066` on `#2d1615` | 6.09:1 (AA) |

In the web app the plain accent (`#0e7c74`) is 4.4:1 on the accent tint, under
AA for 11-12 px tags. Text on the tint therefore uses `--color-accent-text`
(`#0a635c` light, `#5cd6c8` dark, the `--fz-accent-text` row above). It is
applied by one rule in `web/src/index.css` for every element that has both
`bg-accent-soft` and `text-accent`, and `web/src/lib/contrast.test.ts` checks
the ratio in both themes.

## Six agent avatar hues

Six categorical hues (`--fz-agent-1` through `--fz-agent-6`, with named aliases
for `claude`, `codex`, `agy`, `kimi`, `opencode` and `grok`) are derived from
an Okabe-Ito-style separation across both hue and luminance so that users with
protanopia, deuteranopia or tritanopia can tell them apart:

| slot | default CLI | hue name | light (`fg` on `bg`) | ratio (light) | dark (`fg` on `bg`) | ratio (dark) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `--fz-agent-1` | `claude` | Cobalt | `#143e82` on `#e6effc` | 8.88:1 | `#9ec5fc` on `#142238` | 9.00:1 |
| `--fz-agent-2` | `codex` | Amber | `#7a4000` on `#fdf0de` | 7.30:1 | `#f8c98c` on `#2b1f10` | 10.51:1 |
| `--fz-agent-3` | `agy` | Teal | `#09504b` on `#dff3f0` | 8.06:1 | `#7ce3d8` on `#102a28` | 10.00:1 |
| `--fz-agent-4` | `kimi` | Plum | `#63204c` on `#f9e8f3` | 9.70:1 | `#f0b6dc` on `#2a1724` | 9.97:1 |
| `--fz-agent-5` | `opencode` | Sky | `#074d6b` on `#e1f3fa` | 8.06:1 | `#95dcf7` on `#102630` | 10.33:1 |
| `--fz-agent-6` | `grok` | Terracotta | `#7d2610` on `#fceae4` | 8.36:1 | `#f7b5a3` on `#2c1813` | 9.70:1 |

## Density and typography

- **Information density.** faztudo sits next to an editor or terminal. Keep
  chrome narrow: 4px spacing increments, compact channel rows (`28px` height),
  and tight message grouping when consecutive messages come from the same
  author within five minutes.
- **Prose vs. data.** Channel messages and UI labels use `--fz-font-sans` at
  `15px` (`--fz-text-base`) with `1.5` line height. Run output, diffs, lane IDs
  (`codex/default`), exit codes, percentages, token counts and timestamps use
  `--fz-font-mono` with `font-variant-numeric: tabular-nums` so columns line up.
- **Collapsible detail.** Raw `run.output` lines and unified diffs collapse
  behind a summary header showing line count and diff stat (`+42 -11 in 3
  files`), while verification results and approval prompts stay expanded.

## Motion

- **Short and functional.** Transitions use `--fz-duration-fast` (`100ms`) or
  `--fz-duration-normal` (`160ms`) with `--fz-ease-out`. Do not use spring
  bounces or decorative entrance animations.
- **Stable streaming.** Appending `run.output` lines or new chat messages must
  not shift surrounding layout or steal scroll position when the user has
  scrolled up to read earlier messages.
- **Reduced motion.** When `prefers-reduced-motion: reduce` is active,
  durations drop to `0ms` and pulsing/spinning indicators switch to static
  stepped shapes.

## Keyboard first

Every workflow can be completed without a pointer:

- `Ctrl+K` (or `Cmd+K`) opens the command palette to jump to any channel,
  thread, run or lane action.
- `Alt+Up` / `Alt+Down` moves between channels; `Alt+Shift+Up` /
  `Alt+Shift+Down` jumps between unread channels.
- `/` focuses the composer or starts a slash command (`/lane`); `@` opens the
  member autocomplete menu.
- When an approval card is focused (or via the channel's active approval bar),
  number keys `1` through `9` select the numbered option and `Enter` confirms
  the primary option; destructive options (`style: "danger"`) require explicit
  selection and confirmation.
- Every interactive element shows a `2px` solid `--fz-focus-ring` outline with
  a `2px` offset on `:focus-visible`.

## Telling humans and agents apart

Human and agent members share the same channel list and message stream, so the
UI distinguishes them through shape, typography and explicit badges -- never by
avatar color alone:

| attribute | human (`kind: "human"`) | agent (`kind: "agent"`) |
| :--- | :--- | :--- |
| Avatar shape | Circle (`--fz-radius-full`) | Rounded square (`--fz-radius-md`, `6px`) with `1px` border |
| Avatar content | Photo or initials in `--fz-font-sans` | Two-letter uppercase monogram in `--fz-font-mono` (`CL`, `CX`, `AG`, `KM`, `OC`, `GK`) |
| Header badge | None (or `(you)` for the signed-in user) | Monospace `AGENT` pill plus active lane chip (for example `codex/default`) |
| Message container | Plain row on canvas | Run-backed messages include a structured run header and a `2px` left border |

## Run states: color, shape and text

A run state (`RunState` in `docs/api.md`) is always shown as a pill or header
containing a distinct geometric icon, a text label and a semantic color pair.
Color alone is never used to indicate state.

| `state` | icon shape | label text | token group | required detail |
| :--- | :--- | :--- | :--- | :--- |
| `queued` | Dotted circle (`o`) | `Queued` | Neutral (`--fz-text-secondary` on `--fz-bg-subtle`) | Position or target lane |
| `running` | Half-filled ring / play triangle (`>`) | `Running` | Accent (`--fz-accent-text` on `--fz-accent-subtle`) | Elapsed duration and active lane |
| `waiting_approval` | Diamond with exclamation (`<!>`) | `Waiting for approval` | Warn (`--fz-warn-text` on `--fz-warn-subtle`) | Linked approval card in channel |
| `verifying` | Shield / double check outline (`[?]`) | `Verifying` | Accent (`--fz-accent-text` on `--fz-accent-subtle`) | Test command running |
| `done` | Solid circle with checkmark (`[v]`) | `Verified` (or `Done (read)`) | Success (`--fz-success-text` on `--fz-success-subtle`) | Verification status (`ok: true`) and diff stat |
| `failed` | Octagon / square with cross (`[x]`) | `Failed` | Danger (`--fz-danger-text` on `--fz-danger-subtle`) | `failure_class` (`transient`, `semantic`, `unknown`), exit code and failing verification output |
| `cancelled` | Circle with horizontal bar (`[-]`) | `Cancelled` | Neutral (`--fz-text-muted` on `--fz-bg-subtle`) | Who cancelled and when |

Remember rule 4 from `docs/vision.md`: an agent claiming success is not enough.
A write run is shown as `done` only when verification has completed and its
result (`verification.ok` and `verification.detail`) is visible on the run
card.

## Chat readability: the sentence, the quiet line, the fold

- **Run card.** A run card leads with one plain sentence built from fields the
  run already has ("Coder changed 3 files. Tests passed. Waiting for you."),
  so the state is said in words and not only by the dot. One quiet line below
  it gives the lane, mode, elapsed time and why the lane was chosen ("codex/default
  skipped: busy", "retry after kimi/default failed"). The one action that fits
  the state is the filled button: View diff when done, Retry when failed, Cancel
  while working; a pending approval brings its own buttons. A live run shows
  its last three output lines. A failing verification stays open on the card;
  a passing one, the full output and the Open timeline button sit under Details.
- **Agent answers.** The run prompt asks every agent to start its answer with a
  summary of one or two plain sentences. An answer longer than 12 lines shows
  its first 12 lines (cut at a blank line, never inside a code block), the
  headings of the hidden part and a Show all button. Messages people write are
  never folded.
- **Top of a channel.** One strip shows who is working on what and for how
  long, the approvals waiting for you, and lanes in trouble. When the channel
  was opened with unread messages it adds one line from the stored channel
  summary ("Since you were away"); nothing is generated on open.
- **Notices.** A notice that a rule produced (lane fallback, a refused lane,
  a queue, a project assignment, conserve) has a Why? button that names the
  rule. Plain information has none.
- **Projects.** The rail groups channels under their project, with a Needs you
  row that counts pending approvals. `/p/<handle>` is the project home. On a
  phone, Chats, Projects, Office and More form a bottom bar that a channel
  hides so the composer keeps the bottom edge.

## Lane health and usage numbers: color, shape and text

Each lane (`LaneHealth` in `docs/api.md`) combines a distinct icon, a text
label, a bar fill pattern and a semantic color token:

| `health` | icon shape | label text | bar pattern | token group |
| :--- | :--- | :--- | :--- | :--- |
| `available` | Solid circle (`(o)`) | `Available` | Solid fill | Success (`--fz-success-text` / `--fz-success`) |
| `conserve` | Upward triangle (`(^)`) | `Conserve` | Diagonal hatch fill | Warn (`--fz-warn-text` / `--fz-warn`) |
| `exhausted` | Solid square with cross (`[x]`) | `Exhausted` | Full bar with end stop line | Danger (`--fz-danger-text` / `--fz-danger`) |
| `unavailable` | Slashed circle (`(/)`) | `Unavailable` | Muted cross-hatch | Danger / Neutral (`--fz-danger-text` on `--fz-bg-subtle`) |
| `unknown` | Dashed circle with question mark (`(?)`) | `Unknown` | Empty dashed outline (no fill) | Neutral (`--fz-text-muted` on `--fz-bg-subtle`) |

Rules for displaying quota and usage windows:

1. **Source and age on every figure.** Every usage window bar or percentage
   displays its `source` (`cli-log`, `probe`, `error`, `manual`, `unknown`) and
   relative age from `measured_at` (for example `cli-log, 4m ago`) in
   `--fz-font-mono` at `--fz-text-xs`.
2. **Unknown is never zero.** When `used_pct` is absent or `health` is
   `unknown`, render the text `unknown` and an empty dashed gauge. Never render
   `0%` or a full green bar for unmeasured quota.
3. **Announced switches.** When a persona falls back from one lane to the next
   (`lane.switched`), the channel shows an inline notice naming both lanes and
   the reason (for example `Switched @coder from claude/opus to codex/default:
   5h window exhausted`).

## Continuity with the 2D and 3D office views

The 2D isometric office (M4) and 3D office (M6) read the same event stream as
the chat and follow the same visual rules:

- Each member keeps the same `--fz-agent-*` hue, two-letter monogram and
  `@handle` nameplate above their desk.
- Desk state badges use the same geometric shapes and text labels as run cards
  (`Running`, `Waiting for approval`, `Verifying`, `Failed`), so state is never
  conveyed by character animation or color alone.

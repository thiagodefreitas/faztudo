# Built with faztudo

faztudo is developed with faztudo. The maintainer's dogfood instance hosts
the project channels, and most changes start there as a short brief to an
agent; the maintainer also writes code directly. This page records how that
works, with real numbers.

All numbers on this page were measured on the dogfood instance at commit
2982088 on 2026-10-20. Daily work moved into faztudo on 2026-10-17.

## What the dogfood instance has seen

Since 2026-10-17, the instance has seen:

- 118 agent runs across 10 lanes: claude/sonnet 49, codex 25, grok 16,
  claude/fable 7, agy/gemini 7, kimi 5, claude/opus 4, opencode 2,
  agy/sonnet 2 and agy/flash 1.
- 86 write runs -- 61 done, 19 failed, the rest cancelled or still in
  progress -- and 33 read runs (reviews and questions).
- 241 messages and 58 approval decisions.
- 173 commits and 7 releases.

No single lane carries the project. The two busiest lanes (claude/sonnet
and codex) cover about 60% of the runs, and the long tail matters: when
a busy lane hits its quota, one of the quiet ones takes the next run.

Roughly one write run in five fails: a usage limit, a failed check, or a
brief that needed to be sharper. Failed runs stay visible with their
reason, and the work is retried on the next lane or reposted.

## How a change gets made

1. The maintainer writes a short brief and posts it in the project
   channel, mentioning a persona and, when it matters, a lane -- a
   frontend persona on a Claude lane, a coder persona on Codex. The
   brief names the checks to run.
2. Each write run works in its own git worktree. Its output streams
   into the channel, and the run ends with the checks' exit codes.
3. Runs see what the others are doing: a "Working now" section lists
   the active runs and open handoffs, and pinned messages carry the
   rules of the channel.
4. A reviewer persona on a different model reads the diff. A security
   persona checks the risky parts.
5. The maintainer approves or discards each diff, runs the full checks
   and writes the commit.
6. Failures stay visible: a lane that hits its quota is marked, the
   next lane in the chain takes over, and the reason shows on the run
   card.

Agents never commit. A write run leaves its diff in the worktree; the
human reads it, reviews it and writes the commit. All 173 commits were
written by the maintainer.

## What dogfooding found

Using the tool for daily work surfaced problems that a test suite did
not:

- The channel switch bug in 0.1.5 (switching channels left the previous
  channels' transcripts stacked under the new one) was seen while
  working in the real UI, not reported by a test.
- Long channels showed that channel summaries had never worked: the
  summary prompt went over the 128 KiB a single command-line argument
  can hold. Summaries now clip long messages and work in passes.
- One CLI glued the sentences around its tool calls together
  ("can appear.The prompt"). faztudo now puts the space back.
- Quota failover is exercised for real, not simulated: a lane that runs
  dry mid-thread is marked, the next lane in the persona's chain picks
  the work up, and the channel says why the lane changed.

## Why build it this way

Each run ends with the checks it ran and their exit codes, streamed next
to the diff it produced. The maintainer reviews a finished change the
same way a reader of the repository would: prompt, output, diff, tests.
What a lane cannot show -- why it stopped, how much quota is left --
became UI because the need was felt in the channel, not imagined.

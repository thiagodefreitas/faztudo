# Lanes and quota

## What a lane is

A lane is one agent CLI with one model route, for example `claude/opus` or
`codex/default`. Each lane has a capacity (how many runs it may do at once),
a cost class and a `conserve_at` threshold. Lanes live in
`~/.config/faztudo/lanes.toml`. Run `faztudo lanes` to print what faztudo
loaded.

A persona maps to an ordered list of lanes. The router uses the first one
that is usable.

## Health

| state | meaning |
| :--- | :--- |
| available | fresh usage is below the `conserve_at` threshold |
| conserve | fresh usage is at or above the threshold; last resort |
| exhausted | usage is at 100 percent |
| unavailable | the lane cannot be used right now |
| unknown | no fresh number |

A measurement is fresh for 15 minutes. After that the health is unknown, not
a guess. Every number on the Lanes page shows its source and age.

## Where the numbers come from

faztudo reads usage from the CLIs' own local logs and status output, where
they offer one. Not every CLI reports a quota percentage. Claude logs token
totals without a percentage, so its health stays unknown unless you set
`plan_limit_tokens` on the lane to give it a daily limit to measure against.
If a number is wrong, the API (`PATCH /api/v1/lanes/{id}`) accepts a health override and a manual usage window.

## Switching

- **By hand**: `@coder /lane claude/opus ...` for one message. That run
  does not fall back to another lane if the lane fails.
- **For a channel**: `/lane coder claude/opus` makes that lane Coder's
  preferred lane in the channel, and `/lane coder default` clears it. The
  channel settings list what is set.
- **Automatic**: when a lane is exhausted or unavailable, new runs take the
  next usable lane in the persona's list and the channel gets a notice.
  This includes login and plan errors such as an expired sign-in or a
  subscription that no longer covers the CLI: the run that hit the error is
  retried once on the next lane, and the notice names both lanes and the
  reason. Probe the lane from the Lanes page after you fix the problem.
  Conserve lanes run only when nothing else in the chain is usable. A lane
  that is merely busy counts as usable, so the run waits for it.

A run already in progress is not moved.

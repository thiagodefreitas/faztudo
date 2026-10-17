# 0004: Agents run through their own command line tools

Status: accepted, 2026-10-17

## Context

People already pay for and sign in to agent tools such as Claude Code, Codex,
Grok, Kimi, Antigravity and OpenCode. Each tool has a non-interactive mode,
its own quota, and its own quirks.

## Decision

faztudo runs these tools as child processes in their non-interactive modes,
with one adapter per tool that encodes its flags and quirks. It does not call
model APIs directly and does not ask for API keys for these agents. Each run
starts with stdin closed, in its own process group, with known secret
variables removed from its environment, and with a timeout. Write runs use a
git worktree outside the user's checkout.

An agent's own report of success is treated as a claim. A run counts as done
only after faztudo checks the exit code and, for write runs, the resulting
diff and an optional test command.

## Consequences

- Upgrades to an agent tool can break its adapter; each adapter has a fake
  tool for tests and a live check in `faztudo doctor`.
- Usage and quota have to be read from each tool's own logs and errors, so
  the Lanes view shows where every number came from and how old it is.

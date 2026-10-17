# 0002: Bridges are separate processes speaking JSON-RPC over stdio

Status: accepted, 2026-10-17

## Context

Signal, Discord, WhatsApp and other agent hubs each have their own client
libraries, languages and licenses. Some useful tools, such as `signal-cli`,
are GPL licensed and must not be linked into an MIT program.

## Decision

Each bridge is its own process, started and supervised by the daemon. It
talks to the daemon with JSON-RPC 2.0 messages, one per line, on stdin and
stdout. The daemon owns all state; a bridge holds none beyond its own
connection. Every inbound delivery carries an idempotency key derived from
the outside message id, so a repeated delivery is recognized and ignored.
Inbound messages are accepted only from identities on that bridge's
allowlist.

## Consequences

- Bridges can be written in any language and run GPL tools as separate
  programs without affecting faztudo's license.
- A crashing bridge cannot take down the daemon.
- The protocol is documented and versioned so other people can write
  bridges.

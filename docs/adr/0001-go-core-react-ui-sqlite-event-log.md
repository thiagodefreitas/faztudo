# 0001: Go core, React web UI, SQLite event log

Status: accepted, 2026-10-17

Note: the desktop window is a thin client over this same UI; see 0005.

## Context

faztudo has to install in one step, start fast, sit idle cheaply, supervise
many child processes, and push live updates to browsers. The web UI has to
feel current and support a 2D and a 3D office view later. Contributors and AI
helpers should find the stack familiar.

## Decision

- The daemon is written in Go and ships as one static binary with the built
  web UI embedded.
- Storage is SQLite through a pure Go driver (no cgo), in WAL mode. All
  changes are appended to an event log; everything else is a projection that
  can be rebuilt.
- The web UI is React with TypeScript, built with Vite, styled with Tailwind
  CSS. The 2D office uses PixiJS and the 3D office uses three.js through
  react-three-fiber.
- A desktop app, later, wraps the same UI with Tauri.

## Alternatives considered

- **Python daemon.** Good for quick work on subprocesses, but harder to ship
  as one file, slower to start and heavier at idle.
- **TypeScript daemon on Node or Bun.** One language everywhere, and the
  language of the web UI. It loses on three points that matter for a local
  daemon: a cgo-free SQLite driver, direct control of process groups and
  signals, and shipping one static binary with no runtime to install.
- **PostgreSQL.** More than a single-user local tool needs, and one more thing
  to install and keep running.

## Review point

Go stays unless it fails one of two measured gates in M1: a packaged install
on a clean machine, and a crash-recovery test where the daemon dies while a
run's process keeps going.

## Consequences

- Bridges and adapters can still be written in other languages because they
  speak JSON over stdio.
- Contributors need Go and Node for development, but users need neither.

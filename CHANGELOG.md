# Changelog

All notable changes are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Project foundation: license, contribution rules, security policy, design
  documents and decision records, CI with secret scanning and authorship checks.
- Daemon with an SQLite event log, HTTP API and WebSocket stream.
- Agent runs through the Claude Code and Codex CLIs, read-only or in a git
  worktree, with verification, approvals and merge.
- Lanes: usage from the CLIs' own logs, health, and announced switching.
- `faztudo version` with commit and build date; release pipeline and
  versioning policy.

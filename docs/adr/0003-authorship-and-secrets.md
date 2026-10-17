# 0003: Human-authored commits and no secrets in the repository

Status: accepted, 2026-10-17

## Context

faztudo is built with heavy help from AI coding agents. The project wants a
clear owner for every change and a history that is safe to publish.

## Decision

- Every commit is authored and committed by a person. Commit messages carry
  no `Co-authored-by` or similar trailers for tools. A commit-msg hook and a
  CI job enforce this.
- Agents may prepare changes, but a person reviews them and makes the commit.
- No credentials are ever committed. A gitleaks hook runs before each commit,
  and CI scans the full history on every push. `.gitignore` covers env files,
  keys, databases, logs and agent working directories.
- Runtime secrets live in the system keyring or in a 0600 file outside the
  repository.

## Consequences

- Contributors need the hooks installed (`make setup`).
- A leaked secret is treated as compromised: rotate first, then clean up.

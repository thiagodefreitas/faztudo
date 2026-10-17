# Contributing to faztudo

Thanks for looking. faztudo is early, so the most useful contributions right
now are bug reports, design feedback on open issues, and small focused pull
requests against the current milestone.

## Ground rules

- **No secrets, ever.** Do not commit tokens, keys, `.env` files, databases or
  logs. A gitleaks hook runs before each commit and CI scans the whole
  history. If you leak something, rotate it first, then tell us.
- **Humans author commits.** Every commit is authored by a person under their
  own name. Commit messages carry no `Co-authored-by` or other attribution
  trailers for tools. AI tools are welcome as helpers; the person committing
  owns the change and has read it.
- **Plain writing.** Docs, comments and commit messages use plain ASCII
  English: straight quotes, `--` instead of long dashes, no emoji. Say what a
  thing does in the simplest words that are true. `make lint-prose` checks the
  mechanical part.
- **Ideas, not code, from other projects.** Code under licenses that are not
  MIT-compatible (for example the Sustainable Use License or PolyForm
  Noncommercial) must not be copied in, even partly.

## Setup

Requirements: Go 1.25 or newer, Node.js 22, npm, git. Optional: gitleaks and
lefthook for the local hooks.

```bash
git clone https://github.com/thiagodefreitas/faztudo.git
cd faztudo
make setup        # installs the git hooks and web dependencies
make test         # Go and web tests
make dev          # daemon plus web UI with hot reload
```

## Pull requests

1. Open or pick an issue first, so the work is visible and nobody duplicates it.
2. Keep the change focused. One concern per pull request.
3. Add or update tests. Bug fixes come with a test that failed before the fix.
4. Run `make check` (lint, tests, prose, secrets) before pushing.
5. Describe what changed and how you verified it. "It works" is not evidence;
   a command and its output is.

## Design decisions

Larger choices are recorded as short decision records in `docs/adr/`. If your
change goes against one, open an issue to discuss it before writing code.

# Development setup

## Requirements

- Go 1.25 or newer
- Node.js 22 and npm
- git
- Optional: gitleaks and lefthook for the local hooks, and at least one
  signed-in agent CLI if you want to try real runs

## First time

```bash
git clone https://github.com/thiagodefreitas/faztudo.git
cd faztudo
make setup        # installs the git hooks and the web and site dependencies
```

Set your git identity in the clone (`git config user.name` and
`git config user.email`). Commits must be authored by you, without tool
attribution trailers.

## Everyday commands

| command | what it does |
| :--- | :--- |
| `make dev` | runs the daemon and the web dev server together, proxying `/api` |
| `make test` | Go tests (with the race detector) and web tests |
| `make lint-prose` | checks docs for non-ASCII characters and stock phrases |
| `make check` | everything CI runs: prose, authorship, secret scan, tests, licenses |
| `make build` | builds the web app, then `bin/faztudo` with version information |
| `make site` | builds the documentation site |
| `make help` | lists all targets |

Run `make check` before every push.

## Repository layout

| path | holds |
| :--- | :--- |
| `cmd/faztudo/` | the command line entry point |
| `internal/` | the daemon: API, runner, adapters, lanes, store, auth |
| `web/` | the React web app, embedded into the binary at build time |
| `site/` | the Astro Starlight documentation site |
| `docs/` | design documents and decision records (`docs/adr/`) |
| `assets/brand/` | logo, favicon and design tokens |

## Writing rules

Plain ASCII, `--` instead of long dashes, straight quotes, no emoji.
`make lint-prose` checks the mechanical part. The site copies `docs/*.md`
when it builds, so edit the files in `docs/`, not in `site/src/content/docs/`.

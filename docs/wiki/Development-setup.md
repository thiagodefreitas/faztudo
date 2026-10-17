# Development setup

1. Install Go 1.25 or newer, Node.js 22, git, gitleaks and lefthook.
2. Clone the repository and run `make setup` to install the git hooks.
3. Run `make check` before every push. It runs the prose rules, the
   authorship check, a secret scan of the whole history and the tests.
4. Set your git identity in the clone (`git config user.name` and
   `git config user.email`). Commits must be authored by you, without tool
   attribution trailers.

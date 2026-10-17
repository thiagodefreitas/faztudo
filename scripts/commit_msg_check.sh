#!/usr/bin/env bash
# commit-msg hook: rejects attribution trailers in the message being written.
set -euo pipefail
if grep -qiE '^(co-authored-by|claude-session|generated-by):' "$1"; then
  echo "commit-msg: remove attribution trailers (Co-authored-by and similar); see docs/adr/0003" >&2
  exit 1
fi
name="$(git config user.name || true)"; email="$(git config user.email || true)"
echo "commit-msg: committing as $name <$email>" >&2

#!/usr/bin/env bash
# Block commits and pushes that add your own access information: hostnames,
# addresses, device names. The patterns live in .git/info/private-patterns
# (one extended regex per line, # for comments). That file is inside .git,
# so it is never committed or pushed, and it is shared by all worktrees.
#
#   scripts/check_private.sh staged   lines added in the staged changes
#   scripts/check_private.sh push     lines added in commits not on the remote
set -euo pipefail

patterns="$(git rev-parse --git-common-dir)/info/private-patterns"
[ -s "$patterns" ] || exit 0

rules=$(grep -v -e '^[[:space:]]*#' -e '^[[:space:]]*$' "$patterns" || true)
[ -n "$rules" ] || exit 0

case "${1:-staged}" in
staged)
	diff=$(git diff --cached -U0 --no-color --no-ext-diff)
	names=$(git diff --cached --name-only)
	;;
push)
	base=$(git rev-parse --verify -q '@{upstream}' || git rev-parse --verify -q origin/main || true)
	if [ -n "$base" ]; then
		diff=$(git diff -U0 --no-color --no-ext-diff "$base"...HEAD)
		names=$(git diff --name-only "$base"...HEAD)
	else
		diff=$(git log -p --no-color --format= HEAD)
		names=$(git log --name-only --format= HEAD)
	fi
	;;
*)
	echo "usage: $0 staged|push" >&2
	exit 2
	;;
esac

added=$(printf '%s\n' "$diff" | grep -e '^+' | grep -v -e '^+++ ' || true)
hits=$(printf '%s\n%s\n' "$added" "$names" | grep -n -i -E -f <(printf '%s\n' "$rules") || true)
if [ -n "$hits" ]; then
	echo "private access information found (patterns from $patterns):" >&2
	# Show only the matched text, so the hook output does not spread it further.
	printf '%s\n' "$added" "$names" | grep -o -i -E -f <(printf '%s\n' "$rules") | sort -u | sed 's/^/  /' >&2
	echo "Replace it with a placeholder (mypc.tailnet-name.ts.net, 192.0.2.10, <lan-ip>)." >&2
	exit 1
fi

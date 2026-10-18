#!/usr/bin/env bash
# Block commits and pushes that add your own access information: hostnames,
# addresses, device names. The patterns live in .git/info/private-patterns
# (one extended regex per line, matched without case, # for comments). That
# file is inside .git, so it is never committed or pushed, and it is shared
# by all worktrees.
#
#   scripts/check_private.sh staged   lines added in the staged changes
#   scripts/check_private.sh push     every commit being pushed (patches and
#                                     messages), from the refs git passes on
#                                     stdin to the pre-push hook
set -euo pipefail

patterns="$(git rev-parse --git-common-dir)/info/private-patterns"
[ -s "$patterns" ] || exit 0

rules=$(grep -v -e '^[[:space:]]*#' -e '^[[:space:]]*$' "$patterns" || true)
[ -n "$rules" ] || exit 0

zero=0000000000000000000000000000000000000000

case "${1:-staged}" in
staged)
	text=$(
		git diff --cached -U0 --no-color --no-ext-diff | grep -e '^+' | grep -v -e '^+++ ' | sed 's/^+//' || true
		git diff --cached --name-only
	)
	;;
push)
	# One line per ref: <local ref> <local sha> <remote ref> <remote sha>.
	text=""
	while read -r _ local_sha _ remote_sha; do
		[ -n "${local_sha:-}" ] || continue
		[ "$local_sha" = "$zero" ] && continue # deleting a remote ref
		if [ "$remote_sha" = "$zero" ] || ! git cat-file -e "$remote_sha^{commit}" 2>/dev/null; then
			range=("$local_sha" --not --remotes)
		else
			range=("$remote_sha..$local_sha")
		fi
		# Each commit's own patch, so a line added and later removed is still
		# seen, plus its message and the paths it touches.
		text+=$(git log -p --no-color --no-ext-diff --format='%B' "${range[@]}" |
			sed 's/^+//')
		text+=$'\n'
	done
	;;
*)
	echo "usage: $0 staged|push" >&2
	exit 2
	;;
esac

set +e
found=$(printf '%s\n' "$text" | grep -o -i -E -f <(printf '%s\n' "$rules"))
status=$?
set -e
if [ "$status" -gt 1 ]; then
	echo "check_private: a pattern in $patterns is not a valid extended regex; fix it (checking nothing would let everything through)" >&2
	exit 1
fi
if [ -n "$found" ]; then
	echo "private access information found (patterns from $patterns):" >&2
	# Show only the matched text, so the hook output does not spread it further.
	printf '%s\n' "$found" | sort -u | sed 's/^/  /' >&2
	echo "Replace it with a placeholder (mypc.tailnet-name.ts.net, 192.0.2.10, <lan-ip>)." >&2
	exit 1
fi

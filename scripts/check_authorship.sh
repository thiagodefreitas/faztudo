#!/usr/bin/env bash
# Checks every commit in a range (default: all of HEAD):
#   - author and committer are people, not bots or agent identities;
#   - the message carries no attribution trailer for a tool;
#   - if FAZTUDO_ALLOWED_EMAILS is set, the author email is in that list.
# Usage: scripts/check_authorship.sh [rev-range]
set -euo pipefail

range="${1:-HEAD}"
bot_re='(\[bot\]|copilot|noreply@anthropic\.com|noreply@openai\.com|claude|codex|grok|kimi|gemini|antigravity|opencode|dependabot)'
trailer_re='^(co-authored-by|claude-session|generated-by|assisted-by):'

fail=0
while IFS=$'\t' read -r sha an ae cn ce; do
  if grep -qiE "$bot_re" <<<"$an $ae"; then
    echo "commit ${sha:0:12}: author '$an <$ae>' looks like a bot or agent"; fail=1
  fi
  if [[ "$cn" != "GitHub" ]] && grep -qiE "$bot_re" <<<"$cn $ce"; then
    echo "commit ${sha:0:12}: committer '$cn <$ce>' looks like a bot or agent"; fail=1
  fi
  if [[ -n "${FAZTUDO_ALLOWED_EMAILS:-}" ]] && ! grep -qwF -- "$ae" <<<"$FAZTUDO_ALLOWED_EMAILS"; then
    echo "commit ${sha:0:12}: author email '$ae' is not in FAZTUDO_ALLOWED_EMAILS"; fail=1
  fi
  if git log -1 --format=%B "$sha" | grep -qiE "$trailer_re"; then
    echo "commit ${sha:0:12}: message carries an attribution trailer"; fail=1
  fi
done < <(git log --format=$'%H\t%an\t%ae\t%cn\t%ce' "$range")

if [[ $fail -eq 0 ]]; then echo "authorship: ok"; fi
exit "$fail"

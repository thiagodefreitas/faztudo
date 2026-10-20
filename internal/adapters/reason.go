package adapters

import (
	"fmt"
	"regexp"
	"strings"
)

var (
	ansiPattern     = regexp.MustCompile(`\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)`)
	errorishPattern = regexp.MustCompile(`(?i)\b(?:error|fatal)\b\s*[:!]|^\s*(?:error|fatal)\b|panic:|\bFAIL\b|\bfailed to\b|\bcannot\b|permission denied|\bnot found\b|usage limit|rate limit|quota|unauthori[sz]ed|forbidden|not logged in|\b(?:401|403|429)\b|\.go:\d+(?::\d+)?:`)
	diffHeader      = regexp.MustCompile(`^(?:diff --git |index [0-9a-f]+\.\.|\+\+\+ |--- (?:a/|b/|/dev/null|\S+\t))`)
)

const reasonLimit = 300

// StripANSI removes terminal escape sequences and keeps only the last
// carriage-return overwrite of each line.
func StripANSI(s string) string {
	s = ansiPattern.ReplaceAllString(s, "")
	s = strings.ReplaceAll(s, "\r\n", "\n")
	lines := strings.Split(s, "\n")
	for i, l := range lines {
		l = strings.TrimRight(l, "\r")
		if j := strings.LastIndex(l, "\r"); j >= 0 {
			l = l[j+1:]
		}
		lines[i] = l
	}
	return strings.Join(lines, "\n")
}

// withoutDiff drops unified-diff lines that a CLI echoed before failing.
// A tail cut in the middle of a patch has no hunk header before its first
// lines, so once the tail looks like a patch every +, - or space-led line
// goes.
func withoutDiff(lines []string) []string {
	var out []string
	inHunk := false
	patch := looksLikePatch(lines)
	for _, l := range lines {
		if patch && l != "" && !strings.HasPrefix(l, "--- FAIL") {
			// Indented test output ("    x_test.go:12: ...") is kept.
			if l[0] == '+' || l[0] == '-' || (l[0] == ' ' || l[0] == '\t') && !errorishPattern.MatchString(l) {
				continue
			}
		}
		switch {
		case strings.HasPrefix(l, "@@"):
			inHunk = true
			continue
		case diffHeader.MatchString(l):
			inHunk = false
			continue
		case inHunk && l != "" && !strings.HasPrefix(l, "--- FAIL") && (l[0] == '+' || l[0] == '-' || l[0] == ' ' || l[0] == '\\'):
			continue
		}
		inHunk = false
		out = append(out, l)
	}
	return out
}

func looksLikePatch(lines []string) bool {
	n := 0
	for _, l := range lines {
		if strings.HasPrefix(l, "@@ ") || strings.HasPrefix(l, "diff --git ") {
			return true
		}
		if (strings.HasPrefix(l, "+") && !strings.HasPrefix(l, "+++")) || (strings.HasPrefix(l, "-") && !strings.HasPrefix(l, "--")) {
			n++
		}
	}
	return n >= 3
}

// readableExcerpt turns a raw output tail into at most about 300 characters
// that a person can read: no escape codes, no echoed patches, error lines
// first.
func readableExcerpt(tail string) string {
	return excerpt(tail, true)
}

// excerpt keeps error lines first. Without any, it falls back to the last
// lines only when fallback is set.
func excerpt(tail string, fallback bool) string {
	var lines []string
	for _, l := range withoutDiff(strings.Split(StripANSI(tail), "\n")) {
		if l = strings.TrimSpace(l); l != "" {
			lines = append(lines, l)
		}
	}
	var picked []string
	for _, l := range lines {
		if errorishPattern.MatchString(l) {
			picked = append(picked, l)
			if len(picked) == 3 {
				break
			}
		}
	}
	if len(picked) == 0 && fallback {
		picked = lines
		if len(picked) > 3 {
			picked = picked[len(picked)-3:]
		}
	}
	text := strings.Join(picked, "; ")
	if r := []rune(text); len(r) > reasonLimit {
		text = strings.TrimSpace(string(r[:reasonLimit])) + "..."
	}
	return text
}

// messageReason is for failures whose output already says what happened
// (a refusal, a rate limit): the cleaned text alone, without the exit code.
func messageReason(code int, tail string) string {
	if code != 137 && code != 143 {
		if excerpt := readableExcerpt(tail); excerpt != "" {
			return excerpt
		}
	}
	return ReadableReason(code, tail)
}

// ReadableReason builds the failure reason stored for a nonzero exit. It is
// for display only: lane signals are still detected on the raw tail.
func ReadableReason(code int, tail string) string {
	// A killed process often stops mid-output; its signal says more than
	// the last lines unless one of them is an error.
	text := excerpt(tail, code != 137 && code != 143)
	var head string
	switch {
	case code == 137:
		head = "killed (SIGKILL; out of memory, a cancel or the timeout)"
	case code == 143:
		head = "terminated (SIGTERM)"
	case code < 0:
		head = "process did not finish"
	default:
		head = fmt.Sprintf("exit %d", code)
	}
	if text == "" {
		return head
	}
	return head + ": " + text
}

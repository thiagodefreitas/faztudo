package runner

import (
	"regexp"
	"strings"
)

const (
	excerptLines = 40
	excerptAfter = 5
)

var failureLine = regexp.MustCompile(`^\s*(?:--- FAIL|FAIL\b|panic:)|\.go:\d+(?::\d+)?:|\bError:`)

// verificationDetail is the text shown on the run card: the error first, then
// for a failed check only the failing part of the output.
func verificationDetail(passedDetail, output string, verifyErr error) string {
	detail := passedDetail
	if verifyErr != nil {
		detail = verifyErr.Error()
	}
	if output == "" {
		return detail
	}
	if verifyErr != nil {
		return detail + "\n" + failureExcerpt(output)
	}
	return detail + "\n" + strings.TrimRight(output, "\n")
}

// failureExcerpt picks the failing part of verification output: each line
// that looks like a failure plus a few lines after it, at most 40 lines in
// all. With no such line it falls back to the last 40 lines. The full
// output stays in the run log.
func failureExcerpt(output string) string {
	lines := strings.Split(strings.TrimRight(output, "\n"), "\n")
	keep := make([]bool, len(lines))
	hits := 0
	for i, l := range lines {
		if !failureLine.MatchString(l) {
			continue
		}
		hits++
		for j := i; j < len(lines) && j <= i+excerptAfter; j++ {
			keep[j] = true
		}
	}
	if hits == 0 {
		if len(lines) > excerptLines {
			lines = lines[len(lines)-excerptLines:]
		}
		return strings.Join(lines, "\n")
	}
	var out []string
	gap := false
	for i, l := range lines {
		if !keep[i] {
			gap = len(out) > 0
			continue
		}
		if gap {
			out = append(out, "...")
			gap = false
		}
		out = append(out, l)
		if len(out) >= excerptLines {
			out = append(out, "...")
			break
		}
	}
	return strings.Join(out, "\n")
}

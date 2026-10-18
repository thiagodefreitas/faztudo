package app

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestShortenAnswerCutsOnARuneBoundary(t *testing.T) {
	// Three-byte runes and no newline: a raw byte cut would split one.
	got := shortenAnswer(strings.Repeat("€", maxAnswerBytes))
	if !utf8.ValidString(got) {
		t.Fatal("the cut split a UTF-8 character")
	}
	if !strings.HasSuffix(got, "(The answer was longer; the rest is in the run output.)") {
		t.Fatalf("no note: %q", got[len(got)-60:])
	}
}

func TestShortenAnswerKeepsTheStart(t *testing.T) {
	short := "Summary first.\nDetails."
	if got := shortenAnswer(short); got != short {
		t.Fatalf("short answer changed: %q", got)
	}
	long := "Summary first.\n" + strings.Repeat("a line of detail\n", maxAnswerBytes/10)
	got := shortenAnswer(long)
	if !strings.HasPrefix(got, "Summary first.\n") {
		t.Fatalf("the start was lost: %q", got[:40])
	}
	if len(got) > maxAnswerBytes+100 || !strings.HasSuffix(got, "(The answer was longer; the rest is in the run output.)") {
		t.Fatalf("not shortened with a note: %d bytes, ends %q", len(got), got[len(got)-60:])
	}
	if strings.Contains(got, "a line of det\n") {
		t.Fatal("cut inside a line")
	}
}

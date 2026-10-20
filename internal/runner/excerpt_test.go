package runner

import (
	"errors"
	"fmt"
	"strings"
	"testing"
)

func TestFailureExcerpt(t *testing.T) {
	var b strings.Builder
	for i := 0; i < 60; i++ {
		fmt.Fprintf(&b, "ok  \tgithub.com/x/p%d\t0.1s\n", i)
	}
	b.WriteString("--- FAIL: TestX (0.00s)\n    x_test.go:9: got 1 want 2\nFAIL\nFAIL\tgithub.com/x/bad\t0.3s\n")
	for i := 60; i < 80; i++ {
		fmt.Fprintf(&b, "ok  \tgithub.com/x/p%d\t0.1s\n", i)
	}
	got := failureExcerpt(b.String())
	if !strings.Contains(got, "--- FAIL: TestX") || !strings.Contains(got, "x_test.go:9") || !strings.Contains(got, "github.com/x/bad") {
		t.Fatalf("missing failure: %q", got)
	}
	if strings.Contains(got, "p0\t") || strings.Contains(got, "p79") {
		t.Fatalf("kept unrelated ok lines: %q", got)
	}
	if n := len(strings.Split(got, "\n")); n > 41 {
		t.Fatalf("%d lines", n)
	}

	compile := "# github.com/x/y\n./a.go:12:3: undefined: foo\n./a.go:14:1: syntax error\n"
	if got := failureExcerpt(compile); !strings.Contains(got, "a.go:12:3") || !strings.Contains(got, "a.go:14:1") {
		t.Fatalf("compiler: %q", got)
	}

	var tail strings.Builder
	for i := 0; i < 100; i++ {
		fmt.Fprintf(&tail, "line-%03d\n", i)
	}
	got = failureExcerpt(tail.String())
	if strings.Contains(got, "line-059") || !strings.Contains(got, "line-060") || !strings.Contains(got, "line-099") {
		t.Fatalf("fallback tail: %q", got)
	}

	var huge strings.Builder
	for i := 0; i < 100; i++ {
		fmt.Fprintf(&huge, "panic: boom %d\n", i)
	}
	if n := len(strings.Split(failureExcerpt(huge.String()), "\n")); n > 41 {
		t.Fatalf("cap: %d lines", n)
	}
}

func TestVerificationDetail(t *testing.T) {
	output := strings.Repeat("ok  \tgithub.com/x/p\t0.1s\n", 50) + "--- FAIL: TestX (0.00s)\nFAIL\n"
	d := verificationDetail("ok", output, errors.New("verification failed: exit status 1"))
	if !strings.HasPrefix(d, "verification failed: exit status 1\n") || !strings.Contains(d, "--- FAIL: TestX") || strings.Contains(d, "ok  \t") {
		t.Fatalf("detail %q", d)
	}
	if d := verificationDetail("checks passed", "ok  \tx\t1s\n", nil); d != "checks passed\nok  \tx\t1s" {
		t.Fatalf("passed detail %q", d)
	}
}

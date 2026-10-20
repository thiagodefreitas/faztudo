package adapters

import (
	"strings"
	"testing"

	"github.com/thiagodefreitas/faztudo/internal/domain"
)

func TestReadableReason(t *testing.T) {
	diff := "diff --git a/x.go b/x.go\nindex 1a2b3c..4d5e6f 100644\n--- a/x.go\n+++ b/x.go\n@@ -27,6 +29,7 @@ func f()\n \tcontext line\n+\tPostAs func(a int)\n-\told line\n"
	var oks strings.Builder
	for i := 0; i < 30; i++ {
		oks.WriteString("ok  \tgithub.com/x/pkg" + string(rune('a'+i%26)) + "\t0.1s\n")
	}
	cases := []struct {
		name string
		code int
		tail string
		want string
		not  string
	}{
		{"diff chunk", 1, diff + "Error: patch rejected\n", "exit 1: Error: patch rejected", "PostAs"},
		{"diff chunk only", 2, diff + "something stopped\n", "exit 2: something stopped", "@@"},
		{"ansi", 1, "\x1b[91m\x1b[1mError: \x1b[0mCannot connect to API\n", "exit 1: Error: Cannot connect to API", "\x1b"},
		{"carriage return", 1, "progress 10%\rprogress 100%\rError: boom\n", "exit 1: Error: boom", "10%"},
		{"137 empty", 137, "", "killed (SIGKILL; out of memory, a cancel or the timeout)", "exit 137"},
		{"143", 143, "", "terminated (SIGTERM)", ""},
		{"137 with text", 137, "Killed\n", "killed (SIGKILL; out of memory, a cancel or the timeout)", ""},
		// Measured: a killed write run whose tail was cut in the middle of
		// an echoed patch, with no hunk header left.
		{"137 mid patch", 137, "ssName=\"x\">{repoError}</span>\n+      <label>Lead</label>\n+      }).catch((error: unknown) => {\n-  old\n", "killed (SIGKILL; out of memory, a cancel or the timeout)", "label"},
		{"cut patch then quota", 1, "ub.com/x/events\"\n \t\"github.com/x/org\"\n+\tPostAs func(ctx context.Context)\n+\tb\n-\tc\nERROR: You've hit your usage limit.\n", "exit 1: ERROR: You've hit your usage limit.", "PostAs"},
		// A limit line classify did not recognise must still reach the reason.
		{"137 keeps a limit line", 137, "Killed\nYou have reached your usage limit for today\n", "killed (SIGKILL; out of memory, a cancel or the timeout): You have reached your usage limit for today", ""},
		{"go code is not an error", 1, "func git(ctx context.Context) (string, error) {\nthe first run failed because of a fixture\ndone\n", "exit 1: func git(ctx context.Context) (string, error) {; the first run failed because of a fixture; done", ""},
		{"empty tail", 3, "  \n\n", "exit 3", ""},
		{"go test one fail", 1, oks.String() + "--- FAIL: TestX (0.00s)\n    x_test.go:9: bad\nFAIL\nFAIL\tgithub.com/x/pkgz\t0.2s\n", "exit 1: --- FAIL: TestX (0.00s); x_test.go:9: bad; FAIL", "ok  \t"},
		{"compiler error", 1, "# github.com/x\n./a.go:12:3: undefined: foo\n", "exit 1: ./a.go:12:3: undefined: foo", ""},
		{"no error words", 1, "a\nb\nc\nd\n", "exit 1: b; c; d", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := ReadableReason(c.code, c.tail)
			if got != c.want {
				t.Fatalf("got %q, want %q", got, c.want)
			}
			if c.not != "" && strings.Contains(got, c.not) {
				t.Fatalf("%q still contains %q", got, c.not)
			}
		})
	}
	if got := ReadableReason(1, strings.Repeat("error word ", 100)); len([]rune(got)) > 320 {
		t.Fatalf("not clipped: %d runes", len([]rune(got)))
	}
}

func TestClassifyUsesReadableReason(t *testing.T) {
	class, _, reason := classify(137, "")
	if class != domain.FailureUnknown || !strings.HasPrefix(reason, "killed (SIGKILL") {
		t.Fatalf("got %q %q", class, reason)
	}
	_, _, reason = classify(1, "\x1b[31mError: connection reset by peer\x1b[0m\n")
	if reason != "Error: connection reset by peer" {
		t.Fatalf("transient reason %q", reason)
	}
}

func TestQuotaDetectionReadsAnsiTail(t *testing.T) {
	tail := "\x1b[91m\x1b[1mError: \x1b[0mQuota exceeded for this plan. Try later.\x1b[0m\n"
	class, signal, reason := classify(1, tail)
	if class != domain.FailureSemantic || signal.Kind != SignalExhausted {
		t.Fatalf("class=%q signal=%v", class, signal.Kind)
	}
	if strings.Contains(reason, "\x1b") || !strings.Contains(reason, "Quota exceeded") {
		t.Fatalf("reason %q", reason)
	}
}

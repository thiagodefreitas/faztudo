package adapters

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/domain"
)

var fakeCLI string

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "faztudo-fakecli-")
	if err != nil {
		panic(err)
	}
	defer os.RemoveAll(dir)
	fakeCLI = filepath.Join(dir, "fakecli")
	cmd := exec.Command("go", "build", "-o", fakeCLI, "./testdata/fakecli")
	if out, err := cmd.CombinedOutput(); err != nil {
		panic(string(out) + err.Error())
	}
	os.Exit(m.Run())
}

func TestCommands(t *testing.T) {
	for _, tc := range []struct {
		adapter Adapter
		mode    domain.RunMode
		want    []string
	}{
		{Claude{}, domain.RunRead, []string{"-p", "hello", "--model", "opus", "--permission-mode", "default", "--disallowedTools", "Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "--allowedTools", "Read", "Grep", "Glob", "LS"}},
		{Claude{}, domain.RunWrite, append([]string{"-p", "hello", "--model", "opus", "--permission-mode", "acceptEdits", "--allowedTools"}, DefaultClaudeWriteTools...)},
		{Codex{}, domain.RunRead, []string{"exec", "-C", "/tmp/work", "--skip-git-repo-check", "-s", "read-only", "-m", "gpt", "-c", "model_reasoning_effort=high", "hello"}},
		{Codex{}, domain.RunWrite, []string{"exec", "-C", "/tmp/work", "--skip-git-repo-check", "-s", "workspace-write", "-m", "gpt", "-c", "model_reasoning_effort=high", "hello"}},
	} {
		cmd, err := tc.adapter.Command(Request{Prompt: "hello", Mode: tc.mode, Model: "gpt", Effort: "high", Workdir: "/tmp/work"})
		if _, ok := tc.adapter.(Claude); ok {
			cmd, err = tc.adapter.Command(Request{Prompt: "hello", Mode: tc.mode, Model: "opus", Workdir: "/tmp/work"})
		}
		if err != nil {
			t.Fatal(err)
		}
		if strings.Join(cmd.Args, "|") != strings.Join(tc.want, "|") {
			t.Fatalf("%s: %q", tc.adapter.Name(), cmd.Args)
		}
		if cmd.Dir != "/tmp/work" {
			t.Fatal(cmd.Dir)
		}
	}
}

func TestClassification(t *testing.T) {
	for _, a := range []Adapter{Claude{}, Codex{}} {
		for _, tc := range []struct {
			text   string
			class  domain.FailureClass
			signal LaneSignalKind
		}{
			{"HTTP 429 rate limit. Try again in 2 hours", domain.FailureSemantic, SignalExhausted},
			{"HTTP 429 retry in 10 seconds", domain.FailureTransient, SignalNone},
			{"HTTP 503 upstream", domain.FailureTransient, SignalNone},
			{"connection reset by peer", domain.FailureTransient, SignalNone},
			{"bad input", domain.FailureUnknown, SignalNone},
		} {
			class, signal, _ := a.Classify(1, tc.text)
			if class != tc.class || signal.Kind != tc.signal {
				t.Fatalf("%s %q: %s %s", a.Name(), tc.text, class, signal.Kind)
			}
		}
	}
	_, signal, _ := (Codex{}).Classify(1, "HTTP 429 retry in 2 hours")
	if signal.Until.Before(time.Now().Add(119 * time.Minute)) {
		t.Fatalf("reset not parsed: %v", signal.Until)
	}
}

func TestProviderRefusalDoesNotExhaustLane(t *testing.T) {
	for _, tc := range []struct {
		name    string
		adapter Adapter
		text    string
	}{
		{"codex", Codex{}, "ERROR: This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request. Apply for Daybreak access via https://example.test/status-and-access before retrying."},
		{"claude", Claude{}, "API Error: This request was rejected by our safety system. I cannot assist with this request."},
		{"grok", Grok{}, "Error: Request refused by the provider's safety policy. Please rephrase your request."},
	} {
		t.Run(tc.name, func(t *testing.T) {
			class, signal, reason := tc.adapter.Classify(1, tc.text)
			if class != domain.FailureSemantic || signal.Kind != SignalNone || reason != tc.text {
				t.Fatalf("refusal: class=%s signal=%s reason=%q", class, signal.Kind, reason)
			}
		})
	}
}

func TestQuotaWordsInTaskOutputDoNotExhaustLane(t *testing.T) {
	class, signal, _ := Codex{}.Classify(1, "--- FAIL: TestQuotaView\nquota label was missing")
	if class == domain.FailureSemantic && signal.Kind == SignalExhausted {
		t.Fatal("a failed test exhausted the lane")
	}
}

func TestCodexAbsoluteQuotaResetTime(t *testing.T) {
	want := time.Now().Add(2 * time.Hour)
	message := "ERROR: You've hit your usage limit. Try again at " + want.Format("3:04 PM") + "."
	class, signal, _ := Codex{}.Classify(1, message)
	if class != domain.FailureSemantic || signal.Kind != SignalExhausted || signal.Until.IsZero() {
		t.Fatalf("absolute reset was not parsed: %s %+v", class, signal)
	}
	if diff := signal.Until.Sub(want); diff < -time.Minute || diff > time.Minute {
		t.Fatalf("reset %s differs from %s by %s", signal.Until, want, diff)
	}
}

func TestFakeCLI(t *testing.T) {
	cmd := exec.Command(fakeCLI)
	cmd.Env = append(os.Environ(), "FAKE_STDOUT=ok", "FAKE_STDERR=HTTP 429", "FAKE_EXIT=3")
	out, err := cmd.CombinedOutput()
	if err == nil || !strings.Contains(string(out), "HTTP 429") || !strings.Contains(string(out), "ok") {
		t.Fatalf("%q %v", out, err)
	}
}

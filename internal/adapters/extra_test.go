package adapters

import (
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/domain"
)

func TestAdditionalCommands(t *testing.T) {
	workdir := t.TempDir()
	if err := os.WriteFile(filepath.Join(workdir, "AGENTS.md"), []byte("test instructions\n"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		adapter Adapter
		mode    domain.RunMode
		model   string
		effort  string
		want    []string
	}{
		{Grok{}, domain.RunRead, "grok-model", "high", []string{"-p", "hello", "--cwd", workdir, "--sandbox", "read-only", "--no-subagents", "-m", "grok-model", "--reasoning-effort", "high", "--rules", "Read " + filepath.Join(workdir, "AGENTS.md") + " first."}},
		{Grok{}, domain.RunWrite, "", "", []string{"-p", "hello", "--cwd", workdir, "--always-approve", "--rules", "Read " + filepath.Join(workdir, "AGENTS.md") + " first."}},
		{Kimi{}, domain.RunWrite, "kimi-model", "", []string{"-p", "hello", "-m", "kimi-model"}},
		{Agy{}, domain.RunWrite, "agy-model", "high", []string{"--model", "agy-model", "--effort", "high", "--print-timeout", "42s", "--dangerously-skip-permissions", "--new-project", "--print", "hello"}},
		{OpenCode{}, domain.RunWrite, "provider/model", "high", []string{"run", "-m", "provider/model", "--variant", "high", "hello"}},
	} {
		t.Run(tc.adapter.Name()+"/"+string(tc.mode), func(t *testing.T) {
			cmd, err := tc.adapter.Command(Request{Prompt: "hello", Mode: tc.mode, Model: tc.model, Effort: tc.effort, Workdir: workdir, Timeout: 42 * time.Second})
			if err != nil {
				t.Fatal(err)
			}
			if cmd.Path != tc.adapter.Name() || cmd.Dir != workdir || !reflect.DeepEqual(cmd.Args, tc.want) {
				t.Fatalf("command: %#v", cmd)
			}
			fake := exec.Command(fakeCLI, cmd.Args...)
			fake.Dir = cmd.Dir
			fake.Env = append(os.Environ(), "FAKE_PRINT_ARGS=1", "FAKE_PRINT_CWD=1")
			out, err := fake.CombinedOutput()
			if err != nil {
				t.Fatal(err)
			}
			want := strings.Join(tc.want, "\n") + "\n" + workdir + "\n"
			if string(out) != want {
				t.Fatalf("fake CLI output: %q, want %q", out, want)
			}
		})
	}
}

func TestAdditionalReadRefusals(t *testing.T) {
	for _, a := range []Adapter{Kimi{}, Agy{}, OpenCode{}} {
		t.Run(a.Name(), func(t *testing.T) {
			_, err := a.Command(Request{Prompt: "hello", Mode: domain.RunRead, Workdir: t.TempDir()})
			if err == nil || err.Error() != a.Name()+" has no read-only mode" {
				t.Fatalf("read mode error: %v", err)
			}
		})
	}
}

func TestGrokOmitsRulesWithoutAgentInstructions(t *testing.T) {
	cmd, err := (Grok{}).Command(Request{Prompt: "hello", Mode: domain.RunRead, Workdir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	for _, arg := range cmd.Args {
		if arg == "--rules" {
			t.Fatal("unexpected rules pointer")
		}
	}
}

func TestAdditionalClassification(t *testing.T) {
	for _, tc := range []struct {
		adapter Adapter
		tail    string
	}{
		{Grok{}, "HTTP 402 quota exceeded"},
		{Kimi{}, "provider returned 403 monthly quota reached"},
		{Agy{}, "quota exhausted"},
		{OpenCode{}, "HTTP 429 retry in 2 hours"},
	} {
		class, signal, _ := tc.adapter.Classify(1, tc.tail)
		if class != domain.FailureSemantic || signal.Kind != SignalExhausted {
			t.Fatalf("%s: %s %s", tc.adapter.Name(), class, signal.Kind)
		}
		class, signal, _ = tc.adapter.Classify(0, tc.tail)
		if class != "" || signal.Kind != SignalNone {
			t.Fatalf("%s successful exit: %s %s", tc.adapter.Name(), class, signal.Kind)
		}
	}
}

func TestOpenCodeZeroExitProviderError(t *testing.T) {
	output := "\x1b[91m\x1b[1mError: \x1b[0mOpenCode 1.18.0 or newer is required to use the free tier\n"
	for _, streams := range [][2]string{{output, ""}, {"", output}} {
		class, signal, reason := Classify(OpenCode{}, 0, streams[0], streams[1])
		if class != domain.FailureSemantic || signal.Kind != SignalUnavailable || !strings.Contains(reason, "OpenCode 1.18.0 or newer") {
			t.Fatalf("zero-exit error: %s %s %q", class, signal.Kind, reason)
		}
	}
	class, signal, reason := OpenCode{}.ClassifyOutput(0, "Completed task.\n", "")
	if class != "" || signal.Kind != SignalNone || reason != "" {
		t.Fatalf("successful output: %s %s %q", class, signal.Kind, reason)
	}
}

func TestKimiCleanAnswer(t *testing.T) {
	got := Kimi{}.CleanAnswer("\u2022 OK\n\n\u2022 second paragraph\n\nTo resume this session: kimi -r session_x\n")
	if got != "OK\n\nsecond paragraph" {
		t.Fatalf("got %q", got)
	}
	if CleanAnswer(Codex{}, " plain ") != " plain " {
		t.Fatal("adapters without a cleaner must pass output through")
	}
}

func TestAgyQuotaOnlyFromErrorLines(t *testing.T) {
	class, sig, _ := Agy{}.ClassifyOutput(0, "Here is how agy reports it: RESOURCE_EXHAUSTED, Individual quota reached.", "")
	if sig.Kind == SignalExhausted || class == domain.FailureSemantic {
		t.Fatalf("quoted text exhausted the lane: %v %v", class, sig)
	}
	class, sig, reason := Agy{}.ClassifyOutput(0, "error: Individual quota reached. Resets in 4h54m14s.\nAGY_ERROR: {\"status\":\"RESOURCE_EXHAUSTED\"}", "")
	if sig.Kind != SignalExhausted || class != domain.FailureSemantic || sig.Until.IsZero() {
		t.Fatalf("real agy error not classified: %v %v %q", class, sig, reason)
	}
}

func TestGrokCleanAnswerSpacesGluedSentences(t *testing.T) {
	cases := map[string]string{
		"whether it can appear.The prompt builders take a channel id.":       "whether it can appear. The prompt builders take a channel id.",
		"I'll search other trees next.This checkout has no tests!Then stop.": "I'll search other trees next. This checkout has no tests! Then stop.",
		"the budget (org.Ledger) lives in memory":                            "the budget (org.Ledger) lives in memory",
		"see e.g.The docs and fmt.Println and https://x.io/a.B":              "see e.g.The docs and fmt.Println and https://x.io/a.B",
		"call `done.Next` here":                                              "call `done.Next` here",
		"```\nworked.Then x\n```\nit worked.Then left":                       "```\nworked.Then x\n```\nit worked. Then left",
		"Run the tests.Then stop":                                            "Run the tests. Then stop",
		"first.Reviewing the diff":                                           "first. Reviewing the diff",
		"how events are looked up.A signed-in caller":                        "how events are looked up. A signed-in caller",
		"a non-member.`runPrompt` is not here":                               "a non-member. `runPrompt` is not here",
		"call x.`y` and go.Running":                                          "call x.`y` and go.Running",
		"takes a context.Context and store.Rebuild runs":                     "takes a context.Context and store.Rebuild runs",
		"The clock is time.Now, replaced in tests":                           "The clock is time.Now, replaced in tests",
		"waits on group.Done or ctx":                                         "waits on group.Done or ctx",
		"see store.Pending here and lanes.This":                              "see store.Pending here and lanes.This",
	}
	for in, want := range cases {
		if got := (Grok{}).CleanAnswer(in); got != want {
			t.Errorf("CleanAnswer(%q) = %q, want %q", in, got, want)
		}
	}
}

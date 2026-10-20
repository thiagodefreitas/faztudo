package adapters

import (
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/domain"
)

func allowedAfterFlag(args []string) []string {
	for i, a := range args {
		if a == "--allowedTools" {
			var out []string
			for _, v := range args[i+1:] {
				if strings.HasPrefix(v, "--") {
					break
				}
				out = append(out, v)
			}
			return out
		}
	}
	return nil
}

func TestClaudeAllowedTools(t *testing.T) {
	dir := t.TempDir()
	mcp := &MCP{URL: "http://127.0.0.1:9/mcp", Token: strings.Repeat("ab", 32), Dir: filepath.Join(dir, "run")}
	for _, tc := range []struct {
		name string
		req  Request
		want []string
	}{
		{"write default", Request{Mode: domain.RunWrite}, DefaultClaudeWriteTools},
		{"write custom", Request{Mode: domain.RunWrite, AllowedTools: []string{"Bash(make:*)"}}, []string{"Bash(make:*)"}},
		{"write empty list allows none", Request{Mode: domain.RunWrite, AllowedTools: []string{}}, nil},
		{"read default", Request{Mode: domain.RunRead}, ReadRunTools},
		{"read custom", Request{Mode: domain.RunRead, AllowedTools: []string{"Read"}}, []string{"Read"}},
		{"read with mcp", Request{Mode: domain.RunRead, MCP: mcp}, append(append([]string{}, ReadRunTools...), allowedMCPTools...)},
		{"write default with mcp", Request{Mode: domain.RunWrite, MCP: mcp}, append(append([]string{}, DefaultClaudeWriteTools...), allowedMCPTools...)},
		{"write custom with mcp", Request{Mode: domain.RunWrite, MCP: mcp, AllowedTools: []string{"Bash(make:*)"}}, append([]string{"Bash(make:*)"}, allowedMCPTools...)},
	} {
		tc.req.Prompt, tc.req.Workdir = "hello", dir
		cmd, err := (Claude{}).Command(tc.req)
		if err != nil {
			t.Fatal(tc.name, err)
		}
		got := allowedAfterFlag(cmd.Args)
		if strings.Join(got, "|") != strings.Join(tc.want, "|") {
			t.Fatalf("%s: got %q want %q", tc.name, got, tc.want)
		}
	}
}

func TestAllowedToolsIgnoredByOtherAdapters(t *testing.T) {
	dir := t.TempDir()
	req := Request{Prompt: "hello", Mode: domain.RunWrite, Workdir: dir, Timeout: time.Second, AllowedTools: []string{"Bash(make:*)"}}
	for _, a := range []Adapter{Codex{}, Kimi{}, Agy{}, OpenCode{}} {
		cmd, err := a.Command(req)
		if err != nil {
			t.Fatal(a.Name(), err)
		}
		if strings.Contains(strings.Join(cmd.Args, "\n"), "make") {
			t.Fatalf("%s got allowed tools", a.Name())
		}
	}
}

func TestAgyQuotaOnExitZero(t *testing.T) {
	out := `AGY_ERROR {"error":"RESOURCE_EXHAUSTED (code 429): Individual quota reached for claude-opus-5-5-high. Resets in 4h54m14s"}`
	for _, code := range []int{0, 1} {
		class, signal, reason := Classify(Agy{}, code, out, "")
		if class != domain.FailureSemantic || signal.Kind != SignalExhausted {
			t.Fatalf("exit %d: %s %s", code, class, signal.Kind)
		}
		want := time.Now().Add(4*time.Hour + 54*time.Minute + 14*time.Second)
		if d := signal.Until.Sub(want); d < -5*time.Second || d > 5*time.Second {
			t.Fatalf("exit %d: until %v want about %v", code, signal.Until, want)
		}
		if !strings.Contains(reason, "4h54m14s") {
			t.Fatalf("reason %q", reason)
		}
	}
	// Without a reset time the lane is exhausted with no end time.
	class, signal, _ := Classify(Agy{}, 0, "", "RESOURCE_EXHAUSTED")
	if class != domain.FailureSemantic || signal.Kind != SignalExhausted || !signal.Until.IsZero() {
		t.Fatalf("%s %+v", class, signal)
	}
	// A normal answer is still a success.
	class, signal, _ = Classify(Agy{}, 0, "all done", "")
	if class != "" || signal.Kind != SignalNone {
		t.Fatalf("%s %s", class, signal.Kind)
	}
	// Adapters without ClassifyOutput use Classify with the stderr tail.
	class, signal, _ = Classify(Codex{}, 1, "ignored stdout", "HTTP 402 quota exceeded")
	if class != domain.FailureSemantic || signal.Kind != SignalExhausted {
		t.Fatalf("%s %s", class, signal.Kind)
	}
}

// A claude read run is never in plan mode (it writes plan files and will not
// call delegate) and stays read-only by allow-list: only read tools and
// faztudo tools, edits and Bash denied.
func TestClaudeReadRunIsReadOnlyWithoutPlanMode(t *testing.T) {
	mcp := &MCP{URL: "http://127.0.0.1:1/mcp", Token: "t", Dir: t.TempDir()}
	for _, m := range []*MCP{mcp, nil} {
		cmd, err := Claude{}.Command(Request{Prompt: "p", Mode: domain.RunRead, Workdir: t.TempDir(), Timeout: time.Second, MCP: m})
		if err != nil {
			t.Fatal(err)
		}
		args := strings.Join(cmd.Args, " ")
		for _, want := range []string{"--permission-mode default", "--disallowedTools Write Edit MultiEdit NotebookEdit Bash", "--allowedTools Read Grep Glob LS"} {
			if !strings.Contains(args, want) {
				t.Fatalf("missing %q in %s", want, args)
			}
		}
		if strings.Contains(args, "plan") {
			t.Fatalf("read run in plan mode: %s", args)
		}
		if (m != nil) != strings.Contains(args, "mcp__faztudo__delegate") {
			t.Fatalf("faztudo tools with MCP %v: %s", m != nil, args)
		}
	}
	write, _ := Claude{}.Command(Request{Prompt: "p", Mode: domain.RunWrite, Workdir: t.TempDir(), Timeout: time.Second})
	if args := strings.Join(write.Args, " "); !strings.Contains(args, "--permission-mode acceptEdits") || strings.Contains(args, "disallowedTools") {
		t.Fatalf("write run: %s", args)
	}
}

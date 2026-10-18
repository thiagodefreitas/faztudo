package adapters

import (
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/domain"
)

type Request struct {
	Prompt    string
	Mode      domain.RunMode
	Model     string
	Effort    string
	Workdir   string
	ExtraDirs []string
	Timeout   time.Duration
	MCP       *MCP
	// AllowedTools lists the tools a claude run may use without asking.
	// Nil means the adapter default: DefaultClaudeWriteTools for write runs,
	// nothing extra for read runs. The faztudo MCP tools are always added
	// when MCP is set.
	AllowedTools []string
}

// DefaultClaudeWriteTools is what a claude write run may execute when the
// lane sets no allowed_tools: the usual checks and read-only git and gh
// queries, so the agent can verify its own work.
var DefaultClaudeWriteTools = []string{
	"Bash(go test:*)", "Bash(go vet:*)", "Bash(gofmt:*)",
	"Bash(npm test:*)", "Bash(npm run:*)", "Bash(npx vitest:*)",
	"Bash(git status:*)", "Bash(git diff:*)", "Bash(gh issue view:*)",
}

type Cmd struct {
	Path      string
	Args      []string
	Dir       string
	EnvAdd    map[string]string
	EnvRemove []string
	EnvAllow  []string
	// Remove lists files to delete after the run finishes, including retries.
	Remove []string
}

type LaneSignalKind string

const (
	SignalNone        LaneSignalKind = "none"
	SignalExhausted   LaneSignalKind = "exhausted"
	SignalUnavailable LaneSignalKind = "unavailable"
)

type LaneSignal struct {
	Kind  LaneSignalKind
	Until time.Time
}

type Adapter interface {
	Name() string
	Command(Request) (Cmd, error)
	Classify(exitCode int, stderrTail string) (domain.FailureClass, LaneSignal, string)
}

// OutputClassifier is implemented by adapters whose CLI reports failures on
// stdout or with exit code 0. The runner calls it after every attempt,
// including successful exits, with the tails of both streams.
type OutputClassifier interface {
	ClassifyOutput(exitCode int, stdoutTail, stderrTail string) (domain.FailureClass, LaneSignal, string)
}

// Classify classifies one finished attempt. It uses ClassifyOutput when the
// adapter has it and Classify with the stderr tail otherwise.
func Classify(a Adapter, exitCode int, stdoutTail, stderrTail string) (domain.FailureClass, LaneSignal, string) {
	if c, ok := a.(OutputClassifier); ok {
		return c.ClassifyOutput(exitCode, stdoutTail, stderrTail)
	}
	return a.Classify(exitCode, stderrTail)
}

// AnswerCleaner is implemented by adapters whose CLI decorates its final
// answer (bullets, banners) in print mode.
type AnswerCleaner interface {
	CleanAnswer(stdout string) string
}

// CleanAnswer returns the answer text for a.
func CleanAnswer(a Adapter, stdout string) string {
	if c, ok := a.(AnswerCleaner); ok {
		return c.CleanAnswer(stdout)
	}
	return stdout
}

type Claude struct{}

func (Claude) Name() string { return "claude" }
func (Claude) Command(r Request) (Cmd, error) {
	if err := validate(r); err != nil {
		return Cmd{}, err
	}
	args := []string{"-p", r.Prompt}
	if r.Model != "" {
		args = append(args, "--model", r.Model)
	}
	if r.Effort != "" {
		args = append(args, "--effort", r.Effort)
	}
	permission := "plan"
	if r.Mode == domain.RunWrite {
		permission = "acceptEdits"
	}
	args = append(args, "--permission-mode", permission)
	for _, dir := range r.ExtraDirs {
		args = append(args, "--add-dir", dir)
	}
	if tools := claudeTools(r); len(tools) > 0 {
		args = append(args, "--allowedTools")
		args = append(args, tools...)
	}
	return claudeMCP(r, args)
}

// claudeTools builds the --allowedTools list: the lane's list or the write
// default, then the faztudo MCP tools when an MCP config is passed.
func claudeTools(r Request) []string {
	var tools []string
	switch {
	case r.AllowedTools != nil:
		tools = append(tools, r.AllowedTools...)
	case r.Mode == domain.RunWrite:
		tools = append(tools, DefaultClaudeWriteTools...)
	}
	if r.MCP != nil {
		tools = append(tools, allowedMCPTools...)
	}
	return tools
}

func (Claude) Classify(code int, tail string) (domain.FailureClass, LaneSignal, string) {
	return classify(code, tail)
}

type Codex struct{}

func (Codex) Name() string { return "codex" }
func (Codex) Command(r Request) (Cmd, error) {
	if err := validate(r); err != nil {
		return Cmd{}, err
	}
	sandbox := "read-only"
	if r.Mode == domain.RunWrite {
		sandbox = "workspace-write"
	}
	args := []string{"exec", "-C", r.Workdir, "--skip-git-repo-check", "-s", sandbox}
	if r.Model != "" {
		args = append(args, "-m", r.Model)
	}
	if r.Effort != "" {
		args = append(args, "-c", "model_reasoning_effort="+r.Effort)
	}
	for _, dir := range r.ExtraDirs {
		args = append(args, "--add-dir", dir)
	}
	args, err := withCodexMCP(args, r.MCP)
	if err != nil {
		return Cmd{}, err
	}
	args = append(args, r.Prompt)
	return Cmd{Path: "codex", Args: args, Dir: r.Workdir, EnvAllow: []string{"CODEX_HOME"}}, nil
}
func (Codex) Classify(code int, tail string) (domain.FailureClass, LaneSignal, string) {
	return classify(code, tail)
}

func validate(r Request) error {
	if r.Mode != domain.RunRead && r.Mode != domain.RunWrite {
		return errors.New("invalid run mode")
	}
	if r.Workdir == "" {
		return errors.New("workdir required")
	}
	if r.Prompt == "" {
		return errors.New("prompt required")
	}
	return nil
}

var resetPattern = regexp.MustCompile(`(?i)(?:retry|try again|reset|resets)\s+(?:in\s+)?(\d+)\s*(seconds?|minutes?|hours?|days?)`)
var serverErrorPattern = regexp.MustCompile(`\b5\d\d\b`)

// authPattern matches the CLIs' own login and plan failures. A bare 401 or
// 403 does not count: agents often print HTTP status codes from the code they
// are testing.
var authPattern = regexp.MustCompile(`(?i)auth_error|authentication_error|unauthori[sz]ed|not logged in|please (?:log ?in|sign ?in)|upgrade your plan|subscription (?:does not|doesn't|has expired|expired|is inactive|required)|invalid api key|(?:api error|status|http)\W{0,3}40[13]\b`)

// testFailure marks output from tests the agent ran. A CLI login failure
// happens before any work, so a tail with test failures is the task failing.
var testFailure = regexp.MustCompile(`(?m)^\s*(?:--- FAIL|FAIL\s|=== RUN)|_test\.go:\d+|\bAssertionError\b|\bTests?:\s+\d+ failed`)

// authLine returns the first line of tail that reports a login, plan or
// subscription failure, trimmed and capped so it reads as a lane reason.
func authLine(tail string) string {
	if testFailure.MatchString(tail) {
		return ""
	}
	for _, l := range strings.Split(tail, "\n") {
		l = strings.TrimSpace(l)
		if l != "" && authPattern.MatchString(l) {
			if len(l) > 200 {
				l = l[:200]
			}
			return l
		}
	}
	return ""
}

func classify(code int, tail string) (domain.FailureClass, LaneSignal, string) {
	if code == 0 {
		return "", LaneSignal{Kind: SignalNone}, ""
	}
	s := strings.ToLower(tail)
	signal := LaneSignal{Kind: SignalNone}
	var reset time.Duration
	if m := resetPattern.FindStringSubmatch(s); m != nil {
		n, _ := strconv.Atoi(m[1])
		unit := time.Second
		switch {
		case strings.HasPrefix(m[2], "minute"):
			unit = time.Minute
		case strings.HasPrefix(m[2], "hour"):
			unit = time.Hour
		case strings.HasPrefix(m[2], "day"):
			unit = 24 * time.Hour
		}
		reset = time.Duration(n) * unit
	}
	switch {
	case strings.Contains(s, "402"), strings.Contains(s, "quota"), strings.Contains(s, "usage limit"), strings.Contains(s, "monthly limit"), strings.Contains(s, "plan limit"), (strings.Contains(s, "429") || strings.Contains(s, "rate limit")) && reset >= 30*time.Minute:
		signal.Kind = SignalExhausted
		if reset > 0 {
			signal.Until = time.Now().Add(reset)
		}
		return domain.FailureSemantic, signal, tail
	case authLine(tail) != "":
		// The login or plan is the problem, not the task: retrying the
		// same lane cannot help until the person fixes it.
		signal.Kind = SignalUnavailable
		return domain.FailureSemantic, signal, authLine(tail)
	case strings.Contains(s, "429"), strings.Contains(s, "rate limit"), strings.Contains(s, "timeout"), strings.Contains(s, "timed out"), strings.Contains(s, "connection reset"), strings.Contains(s, "connection refused"), serverErrorPattern.MatchString(s):
		return domain.FailureTransient, signal, tail
	default:
		return domain.FailureUnknown, signal, fmt.Sprintf("exit %d: %s", code, tail)
	}
}

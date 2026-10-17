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
}

type Cmd struct {
	Path      string
	Args      []string
	Dir       string
	EnvAdd    map[string]string
	EnvRemove []string
	EnvAllow  []string
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
	return Cmd{Path: "claude", Args: args, Dir: r.Workdir, EnvAllow: []string{"CLAUDE_CONFIG_DIR"}}, nil
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
	case strings.Contains(s, "402"), strings.Contains(s, "quota"), strings.Contains(s, "usage limit"), strings.Contains(s, "403") && strings.Contains(s, "provider"), (strings.Contains(s, "429") || strings.Contains(s, "rate limit")) && reset >= 30*time.Minute:
		signal.Kind = SignalExhausted
		if reset > 0 {
			signal.Until = time.Now().Add(reset)
		}
		return domain.FailureSemantic, signal, tail
	case strings.Contains(s, "429"), strings.Contains(s, "rate limit"), strings.Contains(s, "timeout"), strings.Contains(s, "timed out"), strings.Contains(s, "connection reset"), strings.Contains(s, "connection refused"), serverErrorPattern.MatchString(s):
		return domain.FailureTransient, signal, tail
	default:
		return domain.FailureUnknown, signal, fmt.Sprintf("exit %d: %s", code, tail)
	}
}

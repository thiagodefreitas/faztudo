package adapters

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/domain"
)

type Grok struct{}

func (Grok) Name() string { return "grok" }

func (Grok) Command(r Request) (Cmd, error) {
	if err := validate(r); err != nil {
		return Cmd{}, err
	}
	if len(r.ExtraDirs) != 0 {
		return Cmd{}, fmt.Errorf("grok does not support extra directories")
	}
	args := []string{"-p", r.Prompt, "--cwd", r.Workdir}
	if r.Mode == domain.RunRead {
		args = append(args, "--sandbox", "read-only", "--no-subagents")
	} else {
		args = append(args, "--always-approve")
	}
	if r.Model != "" {
		args = append(args, "-m", r.Model)
	}
	if r.Effort != "" {
		args = append(args, "--reasoning-effort", r.Effort)
	}
	path := filepath.Join(r.Workdir, "AGENTS.md")
	if _, err := os.Stat(path); err == nil {
		args = append(args, "--rules", "Read "+path+" first.")
	} else if !os.IsNotExist(err) {
		return Cmd{}, err
	}
	return Cmd{Path: "grok", Args: args, Dir: r.Workdir}, nil
}

func (Grok) Classify(code int, tail string) (domain.FailureClass, LaneSignal, string) {
	return classify(code, tail)
}

type Kimi struct{}

func (Kimi) Name() string { return "kimi" }

func (Kimi) Command(r Request) (Cmd, error) {
	if err := validate(r); err != nil {
		return Cmd{}, err
	}
	if r.Mode == domain.RunRead {
		return Cmd{}, fmt.Errorf("kimi has no read-only mode")
	}
	if r.Effort != "" {
		return Cmd{}, fmt.Errorf("kimi does not support reasoning effort")
	}
	args := []string{"-p", r.Prompt}
	if r.Model != "" {
		args = append(args, "-m", r.Model)
	}
	for _, dir := range r.ExtraDirs {
		args = append(args, "--add-dir", dir)
	}
	return Cmd{Path: "kimi", Args: args, Dir: r.Workdir}, nil
}

// CleanAnswer drops the bullet kimi puts before each paragraph in print
// mode ("\u2022 OK") and its "To resume this session" hint.
func (Kimi) CleanAnswer(out string) string {
	lines := strings.Split(out, "\n")
	kept := lines[:0]
	for _, l := range lines {
		if strings.HasPrefix(strings.TrimSpace(l), "To resume this session:") {
			continue
		}
		kept = append(kept, strings.TrimPrefix(l, "\u2022 "))
	}
	return strings.TrimSpace(strings.Join(kept, "\n"))
}

func (Kimi) Classify(code int, tail string) (domain.FailureClass, LaneSignal, string) {
	return classify(code, tail)
}

type Agy struct{}

func (Agy) Name() string { return "agy" }

func (Agy) Command(r Request) (Cmd, error) {
	if err := validate(r); err != nil {
		return Cmd{}, err
	}
	if r.Mode == domain.RunRead {
		return Cmd{}, fmt.Errorf("agy has no read-only mode")
	}
	if r.Timeout < 0 {
		return Cmd{}, fmt.Errorf("agy timeout must not be negative")
	}
	args := []string{}
	if r.Model != "" {
		args = append(args, "--model", r.Model)
	}
	if r.Effort != "" {
		args = append(args, "--effort", r.Effort)
	}
	seconds := int64((r.Timeout + time.Second - 1) / time.Second)
	args = append(args, "--print-timeout", fmt.Sprintf("%ds", seconds))
	for _, dir := range r.ExtraDirs {
		args = append(args, "--add-dir", dir)
	}
	args = append(args, "--dangerously-skip-permissions", "--new-project", "--print", r.Prompt)
	return Cmd{Path: "agy", Args: args, Dir: r.Workdir}, nil
}

func (Agy) Classify(code int, tail string) (domain.FailureClass, LaneSignal, string) {
	return classify(code, tail)
}

type OpenCode struct{}

func (OpenCode) Name() string { return "opencode" }

func (OpenCode) Command(r Request) (Cmd, error) {
	if err := validate(r); err != nil {
		return Cmd{}, err
	}
	if r.Mode == domain.RunRead {
		return Cmd{}, fmt.Errorf("opencode has no read-only mode")
	}
	if len(r.ExtraDirs) != 0 {
		return Cmd{}, fmt.Errorf("opencode does not support extra directories")
	}
	args := []string{"run"}
	if r.Model != "" {
		args = append(args, "-m", r.Model)
	}
	if r.Effort != "" {
		args = append(args, "--variant", r.Effort)
	}
	args = append(args, r.Prompt)
	return Cmd{Path: "opencode", Args: args, Dir: r.Workdir}, nil
}

func (OpenCode) Classify(code int, tail string) (domain.FailureClass, LaneSignal, string) {
	return classify(code, tail)
}

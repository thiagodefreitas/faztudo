package worktree

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/domain"
)

type Manager struct{ BaseDir string }
type Worktree struct{ Repo, Path, Branch, BaseCommit string }

func run(ctx context.Context, dir string, args ...string) (string, error) {
	// Repository configuration may have been changed by an agent. Never run
	// its executable Git extensions in the host process.
	flags := []string{"-c", "core.fsmonitor=", "-c", "core.hooksPath=/dev/null"}
	if len(args) > 0 && args[0] == "diff" {
		args = append([]string{"diff", "--no-ext-diff", "--no-textconv"}, args[1:]...)
	}
	cmd := exec.CommandContext(ctx, "git", append(flags, args...)...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("git %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return strings.TrimSpace(string(out)), nil
}
func (m Manager) Create(ctx context.Context, repo, id string) (Worktree, error) {
	if m.BaseDir == "" || id == "" || strings.ContainsAny(id, "/\\.") || id == ".." {
		return Worktree{}, errors.New("invalid worktree configuration or run id")
	}
	abs, err := filepath.Abs(repo)
	if err != nil {
		return Worktree{}, err
	}
	base, err := run(ctx, abs, "rev-parse", "HEAD")
	if err != nil {
		return Worktree{}, err
	}
	if err = os.MkdirAll(m.BaseDir, 0700); err != nil {
		return Worktree{}, err
	}
	w := Worktree{Repo: abs, Path: filepath.Join(m.BaseDir, id), Branch: "fz/" + id, BaseCommit: base}
	if _, err = run(ctx, abs, "worktree", "add", "-b", w.Branch, w.Path, base); err != nil {
		return Worktree{}, err
	}
	return w, nil
}

// artifactDirs and artifactSuffixes name build and test leftovers that a
// run can create (often by running the tests) and that must never be shown
// as the agent's change or committed, even when the repository has no
// .gitignore entry for them.
var (
	artifactDirs = map[string]bool{
		"__pycache__": true, "node_modules": true, ".pytest_cache": true,
		".mypy_cache": true, ".ruff_cache": true, ".venv": true, ".tox": true,
		".gradle": true,
	}
	artifactSuffixes = []string{".pyc", ".pyo"}
)

// IsArtifact reports whether an untracked path is a build or test leftover.
func IsArtifact(path string) bool {
	for _, part := range strings.Split(filepath.ToSlash(path), "/") {
		if artifactDirs[part] {
			return true
		}
	}
	for _, suf := range artifactSuffixes {
		if strings.HasSuffix(path, suf) {
			return true
		}
	}
	return false
}

// untracked lists new files in the worktree that respect .gitignore and are
// not build or test leftovers.
func untracked(ctx context.Context, w Worktree) ([]string, error) {
	out, err := run(ctx, w.Path, "ls-files", "--others", "--exclude-standard", "-z")
	if err != nil {
		return nil, err
	}
	var paths []string
	for _, p := range strings.Split(out, "\x00") {
		if p != "" && !IsArtifact(p) {
			paths = append(paths, p)
		}
	}
	return paths, nil
}

// Stage stages the agent's change for a commit: modifications and deletions
// of tracked files, plus new files that are not build or test leftovers.
func (m Manager) Stage(ctx context.Context, w Worktree) error {
	if _, err := run(ctx, w.Path, "add", "-u", "--", "."); err != nil {
		return err
	}
	paths, err := untracked(ctx, w)
	if err != nil || len(paths) == 0 {
		return err
	}
	_, err = run(ctx, w.Path, append([]string{"add", "--"}, paths...)...)
	return err
}

func (m Manager) Diff(ctx context.Context, w Worktree) (domain.DiffStat, string, error) {
	// Intent-to-add includes untracked files in git diff without staging content.
	paths, err := untracked(ctx, w)
	if err != nil {
		return domain.DiffStat{}, "", err
	}
	if len(paths) > 0 {
		if _, err = run(ctx, w.Path, append([]string{"add", "-N", "--"}, paths...)...); err != nil {
			return domain.DiffStat{}, "", err
		}
	}
	statText, err := run(ctx, w.Path, "diff", "--numstat", w.BaseCommit, "--")
	if err != nil {
		return domain.DiffStat{}, "", err
	}
	diff, err := run(ctx, w.Path, "diff", "--no-ext-diff", "--binary", w.BaseCommit, "--")
	if err != nil {
		return domain.DiffStat{}, "", err
	}
	var stat domain.DiffStat
	for _, line := range strings.Split(statText, "\n") {
		if line == "" {
			continue
		}
		fields := strings.SplitN(line, "\t", 3)
		if len(fields) != 3 {
			continue
		}
		stat.Files++
		n, _ := strconv.Atoi(fields[0])
		stat.Insertions += n
		n, _ = strconv.Atoi(fields[1])
		stat.Deletions += n
	}
	return stat, diff, nil
}
func (m Manager) Verify(ctx context.Context, w Worktree, command string, timeout time.Duration) error {
	if command == "" {
		return nil
	}
	if timeout <= 0 {
		return errors.New("verification timeout required")
	}
	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.Command("sh", "-c", command)
	cmd.Dir = w.Path
	cmd.Stdin = nil
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		return err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			return fmt.Errorf("verification failed: %w", err)
		}
		return nil
	case <-cctx.Done():
		syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		<-done
		return cctx.Err()
	}
}
func (m Manager) Cleanup(ctx context.Context, w Worktree) error {
	if _, err := run(ctx, w.Repo, "worktree", "remove", "--force", w.Path); err != nil {
		return err
	}
	_, err := run(ctx, w.Repo, "branch", "-D", w.Branch)
	return err
}

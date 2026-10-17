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
	cmd := exec.CommandContext(ctx, "git", args...)
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
func (m Manager) Diff(ctx context.Context, w Worktree) (domain.DiffStat, string, error) {
	// Intent-to-add includes untracked files in git diff without staging content.
	untracked, err := run(ctx, w.Path, "ls-files", "--others", "--exclude-standard", "-z")
	if err != nil {
		return domain.DiffStat{}, "", err
	}
	if untracked != "" {
		parts := strings.Split(untracked, "\x00")
		args := []string{"add", "-N", "--"}
		for _, p := range parts {
			if p != "" {
				args = append(args, p)
			}
		}
		if len(args) > 3 {
			if _, err = run(ctx, w.Path, args...); err != nil {
				return domain.DiffStat{}, "", err
			}
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

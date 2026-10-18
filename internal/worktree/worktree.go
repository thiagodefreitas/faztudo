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

// Worktree is one run's checkout. Admin is the run's own administration
// directory inside the shared git directory (<git dir>/worktrees/<name>).
type Worktree struct{ Repo, Path, Branch, BaseCommit, Admin string }

// ErrTampered means the agent changed the worktree's .git file.
var ErrTampered = errors.New("worktree was tampered with")

func run(ctx context.Context, dir string, args ...string) (string, error) {
	return runGit(ctx, dir, nil, args...)
}

// HostGit applies the same restrictions to host commands on the trusted
// checkout, including the final merge that checks out an agent's changes.
func HostGit(ctx context.Context, dir string, args ...string) (string, error) {
	return runGit(ctx, dir, nil, args...)
}

// runGit runs host-side git. Repository configuration may have been changed
// by an agent, so never run its executable Git extensions in the host process.
func runGit(ctx context.Context, dir string, prefix []string, args ...string) (string, error) {
	flags := []string{"-c", "core.fsmonitor=", "-c", "core.hooksPath=/dev/null"}
	flags = append(flags, prefix...)
	filters, err := disabledFilters(ctx, dir, flags)
	if err != nil {
		return "", err
	}
	flags = append(flags, filters...)
	if len(args) > 0 && args[0] == "diff" {
		args = append([]string{"diff", "--no-ext-diff", "--no-textconv"}, args[1:]...)
	}
	cmd := exec.CommandContext(ctx, "git", append(flags, args...)...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_ATTR_NOSYSTEM=1")
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("git %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return strings.TrimSpace(string(out)), nil
}

// disabledFilters reads the effective repo, global and system configuration
// before any host command touches agent-controlled paths. Attributes in the
// worktree may select a configured driver, so each driver's executable
// commands are overridden with empty values for this invocation.
func disabledFilters(ctx context.Context, dir string, flags []string) ([]string, error) {
	args := append(append([]string(nil), flags...), "config", "--includes", "--null", "--name-only", "--get-regexp", `^filter\..*\.(clean|smudge|process|required)$`)
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_ATTR_NOSYSTEM=1")
	out, err := cmd.Output()
	if err != nil {
		var exited *exec.ExitError
		if errors.As(err, &exited) && exited.ExitCode() == 1 {
			return nil, nil
		}
		return nil, fmt.Errorf("list git filters: %w", err)
	}
	seen := map[string]bool{}
	var overrides []string
	for _, key := range strings.Split(string(out), "\x00") {
		if key == "" {
			continue
		}
		first := strings.IndexByte(key, '.')
		last := strings.LastIndexByte(key, '.')
		if first < 0 || last <= first+1 {
			continue
		}
		name := key[first+1 : last]
		if seen[name] {
			continue
		}
		seen[name] = true
		for _, field := range []string{"clean=", "smudge=", "process=", "required=false"} {
			overrides = append(overrides, "-c", "filter."+name+"."+field)
		}
	}
	return overrides, nil
}

// runIn runs git on an agent worktree. It never trusts the worktree's own
// .git: the git directory and work tree are named explicitly, so a .git file
// or repository the agent put there is not read, and neither is any filter,
// alias or config defined in it. Drivers from the real repo, global and
// system configuration are disabled by runGit.
func runIn(ctx context.Context, w Worktree, args ...string) (string, error) {
	if w.Admin == "" {
		return "", errors.New("worktree git directory unknown")
	}
	return runGit(ctx, w.Path, []string{"-c", "core.attributesFile=/dev/null", "--git-dir=" + w.Admin, "--work-tree=" + w.Path}, args...)
}

// Git runs host-side git on the run's worktree after checking that the agent
// left its .git file alone.
func (m Manager) Git(ctx context.Context, w Worktree, args ...string) (string, error) {
	if err := m.Check(w); err != nil {
		return "", err
	}
	return runIn(ctx, w, args...)
}

// Commit makes a commit as the human: their Git identity, not the run's.
func (m Manager) Commit(ctx context.Context, w Worktree, message string) error {
	if err := m.Check(w); err != nil {
		return err
	}
	flags := []string{"-c", "core.fsmonitor=", "-c", "core.hooksPath=/dev/null", "-c", "core.attributesFile=/dev/null", "--git-dir=" + w.Admin, "--work-tree=" + w.Path}
	filters, err := disabledFilters(ctx, w.Path, flags)
	if err != nil {
		return err
	}
	cmd := exec.CommandContext(ctx, "git", append(append(flags, filters...), "commit", "-q", "-m", message)...)
	cmd.Dir = w.Path
	cmd.Env = []string{"GIT_ATTR_NOSYSTEM=1"}
	for _, kv := range os.Environ() {
		key, _, _ := strings.Cut(kv, "=")
		if !strings.HasPrefix(key, "GIT_AUTHOR_") && !strings.HasPrefix(key, "GIT_COMMITTER_") {
			cmd.Env = append(cmd.Env, kv)
		}
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("git commit: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func gitFile(admin string) string { return "gitdir: " + admin + "\n" }

// adminDir finds the run's administration directory from the trusted repo.
func adminDir(ctx context.Context, repo, path string) (string, error) {
	out, err := run(ctx, repo, "rev-parse", "--git-common-dir")
	if err != nil {
		return "", err
	}
	if !filepath.IsAbs(out) {
		out = filepath.Join(repo, out)
	}
	common, err := filepath.Abs(out)
	if err != nil {
		return "", err
	}
	return filepath.Join(common, "worktrees", filepath.Base(path)), nil
}

// Open rebuilds a Worktree for an existing run from the trusted repository.
func (m Manager) Open(ctx context.Context, repo, path, branch, base string) (Worktree, error) {
	admin, err := adminDir(ctx, repo, path)
	if err != nil {
		return Worktree{}, err
	}
	return Worktree{Repo: repo, Path: path, Branch: branch, BaseCommit: base, Admin: admin}, nil
}

// Check fails with ErrTampered unless the worktree and admin pointers still
// contain the exact values faztudo wrote. A config.worktree is forbidden:
// this manager never writes one and host git must not load agent settings.
func (m Manager) Check(w Worktree) error {
	if w.Admin == "" {
		return errors.New("worktree git directory unknown")
	}
	path := filepath.Join(w.Path, ".git")
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() {
		return fmt.Errorf("%w: its .git file is missing or not a plain file; nothing was diffed or merged", ErrTampered)
	}
	got, err := os.ReadFile(path)
	if err != nil || string(got) != gitFile(w.Admin) {
		return fmt.Errorf("%w: its .git file no longer points at the run's git directory; nothing was diffed or merged", ErrTampered)
	}
	admin, err := os.Lstat(w.Admin)
	if err != nil || !admin.IsDir() || admin.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("%w: its git admin directory changed; nothing was diffed or merged", ErrTampered)
	}
	for name, expected := range map[string]string{
		"commondir": "../..\n",
		"gitdir":    filepath.Join(w.Path, ".git") + "\n",
	} {
		p := filepath.Join(w.Admin, name)
		info, statErr := os.Lstat(p)
		if statErr != nil || !info.Mode().IsRegular() {
			return fmt.Errorf("%w: git admin %s changed; nothing was diffed or merged", ErrTampered, name)
		}
		body, readErr := os.ReadFile(p)
		if readErr != nil || string(body) != expected {
			return fmt.Errorf("%w: git admin %s changed; nothing was diffed or merged", ErrTampered, name)
		}
	}
	if _, err := os.Lstat(filepath.Join(w.Admin, "config.worktree")); !os.IsNotExist(err) {
		return fmt.Errorf("%w: git admin config.worktree appeared; nothing was diffed or merged", ErrTampered)
	}
	return nil
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
	// Write the .git file ourselves so Check can compare it byte for byte.
	if w.Admin, err = adminDir(ctx, abs, w.Path); err == nil {
		if _, err = os.Stat(w.Admin); err == nil {
			err = os.WriteFile(filepath.Join(w.Path, ".git"), []byte(gitFile(w.Admin)), 0644)
		}
	}
	if err != nil {
		_ = m.Cleanup(context.Background(), w)
		return Worktree{}, fmt.Errorf("worktree git directory: %w", err)
	}
	if err := m.Check(w); err != nil {
		_ = m.Cleanup(context.Background(), w)
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
	out, err := runIn(ctx, w, "ls-files", "--others", "--exclude-standard", "-z")
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
	if err := m.Check(w); err != nil {
		return err
	}
	if _, err := runIn(ctx, w, "add", "-u", "--", "."); err != nil {
		return err
	}
	paths, err := untracked(ctx, w)
	if err != nil || len(paths) == 0 {
		return err
	}
	_, err = runIn(ctx, w, append([]string{"add", "--"}, paths...)...)
	return err
}

func (m Manager) Diff(ctx context.Context, w Worktree) (domain.DiffStat, string, error) {
	if err := m.Check(w); err != nil {
		return domain.DiffStat{}, "", err
	}
	// Intent-to-add includes untracked files in git diff without staging content.
	paths, err := untracked(ctx, w)
	if err != nil {
		return domain.DiffStat{}, "", err
	}
	if len(paths) > 0 {
		if _, err = runIn(ctx, w, append([]string{"add", "-N", "--"}, paths...)...); err != nil {
			return domain.DiffStat{}, "", err
		}
	}
	statText, err := runIn(ctx, w, "diff", "--numstat", w.BaseCommit, "--")
	if err != nil {
		return domain.DiffStat{}, "", err
	}
	diff, err := runIn(ctx, w, "diff", "--binary", w.BaseCommit, "--")
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

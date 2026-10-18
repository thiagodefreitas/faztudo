package sandbox

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func hostGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v: %s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

// refsFixture is a repository with a main branch and one linked run worktree.
type refsFixture struct {
	repo, git, tree, state, home, base string
}

func newRefsFixture(t *testing.T) refsFixture {
	t.Helper()
	root := t.TempDir()
	f := refsFixture{repo: filepath.Join(root, "repo"), tree: filepath.Join(root, "trees", "run7"), state: filepath.Join(root, "state"), home: filepath.Join(root, "home")}
	for _, p := range []string{f.repo, f.state, f.home} {
		if err := os.MkdirAll(p, 0700); err != nil {
			t.Fatal(err)
		}
	}
	hostGit(t, f.repo, "init", "-q", "-b", "main")
	hostGit(t, f.repo, "config", "user.name", "Test")
	hostGit(t, f.repo, "config", "user.email", "test@example.invalid")
	if err := os.WriteFile(filepath.Join(f.repo, "a.txt"), []byte("a\n"), 0600); err != nil {
		t.Fatal(err)
	}
	hostGit(t, f.repo, "add", "a.txt")
	hostGit(t, f.repo, "commit", "-q", "-m", "base")
	f.base = hostGit(t, f.repo, "rev-parse", "HEAD")
	hostGit(t, f.repo, "worktree", "add", "-q", "-b", "fz/run7", f.tree, f.base)
	f.git = filepath.Join(f.repo, ".git")
	return f
}

func (f refsFixture) run(t *testing.T, script string) {
	t.Helper()
	args, err := Build(Options{Worktree: f.tree, GitDir: f.git, Home: f.home, CLI: "codex", StateDir: f.state, Branch: "fz/run7"})
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("bwrap", append(args, "--", "/bin/sh", "-c", script)...)
	cmd.Dir = f.tree
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("sandbox script failed: %v: %s", err, out)
	}
}

func TestSharedRefsAreReadOnlyExceptTheRunBranch(t *testing.T) {
	if err := Probe(context.Background(), true); err != nil {
		t.Skipf("bubblewrap unavailable: %v", err)
	}
	f := newRefsFixture(t)
	g := "git -c user.name=Agent -c user.email=agent@example.invalid "
	f.run(t, ""+
		// Its own branch works, reflog included.
		g+"commit --allow-empty -q -m work || exit 25; "+
		// The agent cannot move main, create a branch or tag, or touch
		// another run's branch.
		"if "+g+"update-ref refs/heads/main HEAD 2>/dev/null; then exit 21; fi; "+
		"if "+g+"update-ref refs/heads/other HEAD 2>/dev/null; then exit 22; fi; "+
		"if "+g+"tag evil 2>/dev/null; then exit 23; fi; "+
		// Refs it makes under fz/ stay in its private copy (checked below).
		g+"update-ref refs/heads/fz/other HEAD; "+
		// It cannot replace the .git file that host git trusts.
		"if rm .git 2>/dev/null; then exit 26; fi; "+
		"if echo x > .git 2>/dev/null; then exit 27; fi; "+
		"if echo x >> "+f.git+"/config 2>/dev/null; then exit 28; fi")
	if got := hostGit(t, f.repo, "rev-parse", "refs/heads/main"); got != f.base {
		t.Fatalf("main moved to %s", got)
	}
	if got := hostGit(t, f.repo, "rev-parse", "refs/heads/fz/run7"); got != f.base {
		t.Fatalf("host branch %s moved to %s; the run's ref lives in its private copy", "fz/run7", got)
	}
	if out := hostGit(t, f.repo, "tag", "--list"); out != "" {
		t.Fatalf("tags created: %q", out)
	}
	if out := hostGit(t, f.repo, "branch", "--list", "other", "fz/other"); out != "" {
		t.Fatalf("branches created: %q", out)
	}
}

func TestRefsArgvBindsOnlyTheRunBranchDirectory(t *testing.T) {
	f := newRefsFixture(t)
	args, err := Build(Options{Worktree: f.tree, GitDir: f.git, Home: f.home, CLI: "codex", StateDir: f.state, Branch: "fz/run7"})
	if err != nil {
		t.Fatal(err)
	}
	for _, rel := range []string{"refs", "logs", "packed-refs"} {
		if hasBind(args, "--bind", filepath.Join(f.git, rel)) {
			t.Fatalf("%s is writable", rel)
		}
	}
	if !hasMount(args, "--bind", filepath.Join(f.state, "git-refs", "heads"), filepath.Join(f.git, "refs", "heads", "fz")) ||
		!hasMount(args, "--bind", filepath.Join(f.state, "git-refs", "logs"), filepath.Join(f.git, "logs", "refs", "heads", "fz")) {
		t.Fatalf("run branch directories are not private binds: %v", args)
	}
	if !hasMount(args, "--ro-bind", filepath.Join(f.tree, ".git"), filepath.Join(f.tree, ".git")) {
		t.Fatalf("worktree .git is not read-only: %v", args)
	}
	if _, err := Build(Options{Worktree: f.tree, GitDir: f.git, Home: f.home, CLI: "codex", StateDir: f.state, Branch: "../main"}); err == nil {
		t.Fatal("accepted a branch outside fz/")
	}
}

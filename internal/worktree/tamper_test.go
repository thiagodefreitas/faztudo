package worktree

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// repoWithCommit makes a repository with one commit and returns it and the
// base commit.
func repoWithCommit(t *testing.T, root string) (string, string) {
	t.Helper()
	repo := filepath.Join(root, "repo")
	if err := os.Mkdir(repo, 0700); err != nil {
		t.Fatal(err)
	}
	gitTest(t, repo, "init", "-q")
	gitTest(t, repo, "config", "user.name", "Test")
	gitTest(t, repo, "config", "user.email", "test@example.invalid")
	if err := os.WriteFile(filepath.Join(repo, "tracked.txt"), []byte("old\n"), 0600); err != nil {
		t.Fatal(err)
	}
	gitTest(t, repo, "add", "tracked.txt")
	gitTest(t, repo, "commit", "-q", "-m", "base")
	return repo, gitTest(t, repo, "rev-parse", "HEAD")
}

// replaceWorktreeGit does what a hostile agent does in the security review:
// it deletes the worktree's .git file, creates its own repository whose
// objects come from the real one, and defines a clean filter that runs a
// command.
func replaceWorktreeGit(t *testing.T, repo, tree, marker string) {
	t.Helper()
	if err := os.Remove(filepath.Join(tree, ".git")); err != nil {
		t.Fatal(err)
	}
	gitTest(t, tree, "init", "-q")
	info := filepath.Join(tree, ".git", "objects", "info")
	if err := os.MkdirAll(info, 0700); err != nil {
		t.Fatal(err)
	}
	realObjects := filepath.Join(repo, ".git", "objects")
	if err := os.WriteFile(filepath.Join(info, "alternates"), []byte(realObjects+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	gitTest(t, tree, "config", "filter.pwn.clean", "touch "+marker+"; cat")
	for name, body := range map[string]string{".gitattributes": "* filter=pwn\n", "tracked.txt": "new\n", "added.txt": "hello\n"} {
		if err := os.WriteFile(filepath.Join(tree, name), []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
	}
}

func TestReplacedWorktreeGitIsTamperedAndRunsNoFilter(t *testing.T) {
	root := t.TempDir()
	repo, _ := repoWithCommit(t, root)
	m := Manager{BaseDir: filepath.Join(root, "worktrees")}
	w, err := m.Create(context.Background(), repo, "run3")
	if err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(root, "pwned")
	replaceWorktreeGit(t, repo, w.Path, marker)

	if _, _, err := m.Diff(context.Background(), w); err == nil || !strings.Contains(err.Error(), "tampered") {
		t.Fatalf("Diff accepted a replaced .git: %v", err)
	}
	if err := m.Stage(context.Background(), w); err == nil || !strings.Contains(err.Error(), "tampered") {
		t.Fatalf("Stage accepted a replaced .git: %v", err)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatalf("host git ran the agent's clean filter: %v", err)
	}
}

// Even without the tamper check, host git must never read the worktree's own
// .git: the explicit --git-dir is what stops the filter.
func TestHostGitUsesExplicitGitDirNotTheWorktreeOne(t *testing.T) {
	root := t.TempDir()
	repo, _ := repoWithCommit(t, root)
	m := Manager{BaseDir: filepath.Join(root, "worktrees")}
	w, err := m.Create(context.Background(), repo, "run4")
	if err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(root, "pwned")
	replaceWorktreeGit(t, repo, w.Path, marker)
	if _, err := runIn(context.Background(), w, "add", "-N", "--", "added.txt"); err != nil {
		t.Fatal(err)
	}
	if _, err := runIn(context.Background(), w, "add", "--", "tracked.txt"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatalf("host git ran the agent's clean filter: %v", err)
	}
}

func TestIntactWorktreePassesTheTamperCheck(t *testing.T) {
	root := t.TempDir()
	repo, _ := repoWithCommit(t, root)
	m := Manager{BaseDir: filepath.Join(root, "worktrees")}
	w, err := m.Create(context.Background(), repo, "run5")
	if err != nil {
		t.Fatal(err)
	}
	if err := m.Check(w); err != nil {
		t.Fatal(err)
	}
	reopened, err := m.Open(context.Background(), repo, w.Path, w.Branch, w.BaseCommit)
	if err != nil || reopened.Admin != w.Admin {
		t.Fatalf("Open: %+v, %v", reopened, err)
	}
	// A retargeted gitdir line is tampering too.
	if err := os.WriteFile(filepath.Join(w.Path, ".git"), []byte("gitdir: "+filepath.Join(root, "elsewhere")+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := m.Check(w); err == nil {
		t.Fatal("retargeted .git passed the check")
	}
}

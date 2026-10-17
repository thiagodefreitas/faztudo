package worktree

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func gitTest(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %s: %v", args, out, err)
	}
	return strings.TrimSpace(string(out))
}
func TestWorktreeDiffVerifyCleanup(t *testing.T) {
	root := t.TempDir()
	repo := filepath.Join(root, "repo")
	if err := os.Mkdir(repo, 0700); err != nil {
		t.Fatal(err)
	}
	gitTest(t, repo, "init", "-q")
	if err := os.WriteFile(filepath.Join(repo, "tracked.txt"), []byte("old\n"), 0600); err != nil {
		t.Fatal(err)
	}
	gitTest(t, repo, "add", "tracked.txt")
	tree := gitTest(t, repo, "write-tree")
	cmd := exec.Command("git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit-tree", tree, "-m", "base")
	cmd.Dir = repo
	out, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	base := strings.TrimSpace(string(out))
	gitTest(t, repo, "update-ref", "HEAD", base)
	m := Manager{BaseDir: filepath.Join(root, "worktrees")}
	w, err := m.Create(context.Background(), repo, "run1")
	if err != nil {
		t.Fatal(err)
	}
	if w.BaseCommit != base {
		t.Fatalf("base %s", w.BaseCommit)
	}
	os.WriteFile(filepath.Join(w.Path, "tracked.txt"), []byte("new\n"), 0600)
	os.WriteFile(filepath.Join(w.Path, "added.txt"), []byte("hello\n"), 0600)
	stat, diff, err := m.Diff(context.Background(), w)
	if err != nil {
		t.Fatal(err)
	}
	if stat.Files != 2 || stat.Insertions != 2 || stat.Deletions != 1 || !strings.Contains(diff, "added.txt") {
		t.Fatalf("%+v %s", stat, diff)
	}
	if err := m.Verify(context.Background(), w, "test -f added.txt", time.Second); err != nil {
		t.Fatal(err)
	}
	if err := m.Verify(context.Background(), w, "exit 7", time.Second); err == nil {
		t.Fatal("accepted failure")
	}
	if err := m.Verify(context.Background(), w, "sleep 2", 30*time.Millisecond); err == nil {
		t.Fatal("verification timeout succeeded")
	}
	if err := m.Cleanup(context.Background(), w); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(w.Path); !os.IsNotExist(err) {
		t.Fatalf("worktree still exists: %v", err)
	}
}

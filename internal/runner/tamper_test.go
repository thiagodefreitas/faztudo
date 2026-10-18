package runner

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/adapters"
	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/sandbox"
	"github.com/thiagodefreitas/faztudo/internal/worktree"
)

func tamperRepo(t *testing.T, root string) string {
	t.Helper()
	repo := filepath.Join(root, "repo")
	if err := os.Mkdir(repo, 0700); err != nil {
		t.Fatal(err)
	}
	gitRun(t, repo, "init", "-q")
	if err := os.WriteFile(filepath.Join(repo, "file.txt"), []byte("old\n"), 0600); err != nil {
		t.Fatal(err)
	}
	gitRun(t, repo, "add", "file.txt")
	gitRun(t, repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", "base")
	return repo
}

// An agent that is not sandboxed can replace the worktree's .git. The run must
// then fail as tampered, run no filter, and produce no diff to approve.
func TestReplacedWorktreeGitFailsTheRun(t *testing.T) {
	root := t.TempDir()
	repo := tamperRepo(t, root)
	marker := filepath.Join(root, "pwned")
	script := "rm .git; git init -q; mkdir -p .git/objects/info; echo '" + repo + "/.git/objects' > .git/objects/info/alternates; " +
		"git config filter.pwn.clean 'touch " + marker + "; cat'; echo '* filter=pwn' > .gitattributes; printf new > file.txt; printf more > added.txt"
	r := Runner{RunDir: filepath.Join(root, "runs"), Backoff: []time.Duration{}}
	run := domain.Run{ID: "tamper", Mode: domain.RunWrite, State: domain.RunQueued}
	err := r.ExecuteWrite(context.Background(), &run, sandboxShell{script: script}, adapters.Request{Mode: domain.RunWrite, Prompt: "x"}, WriteOptions{
		Repo: repo, Worktrees: worktree.Manager{BaseDir: filepath.Join(root, "trees")},
	})
	if err == nil || run.State != domain.RunFailed || !strings.Contains(run.FailureReason, "tampered") {
		t.Fatalf("tampered run: state=%s reason=%q err=%v", run.State, run.FailureReason, err)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatalf("host git ran the agent's filter: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "runs", "tamper", "diff.patch")); !os.IsNotExist(err) {
		t.Fatalf("a diff was produced for a tampered worktree: %v", err)
	}
}

// Inside the sandbox the agent cannot replace .git at all, so the same attempt
// leaves an intact worktree whose diff is still the real change.
func TestSandboxedAgentCannotReplaceWorktreeGit(t *testing.T) {
	if err := sandbox.Probe(context.Background(), true); err != nil {
		t.Skipf("bubblewrap unavailable: %v", err)
	}
	root := t.TempDir()
	repo := tamperRepo(t, root)
	r := Runner{RunDir: filepath.Join(root, "runs"), Backoff: []time.Duration{}}
	run := domain.Run{ID: "intact", Mode: domain.RunWrite, State: domain.RunQueued}
	err := r.ExecuteWrite(context.Background(), &run, sandboxShell{script: "rm -f .git; mv .git .git.x 2>/dev/null; printf new > file.txt"}, adapters.Request{Mode: domain.RunWrite, Prompt: "x"}, WriteOptions{
		Repo: repo, Worktrees: worktree.Manager{BaseDir: filepath.Join(root, "trees")}, SandboxMode: "required", Network: true,
	})
	if err != nil || run.State != domain.RunWaitingApproval {
		t.Fatalf("sandboxed run: state=%s reason=%q err=%v", run.State, run.FailureReason, err)
	}
	if _, err := os.Stat(filepath.Join(run.Worktree, ".git")); err != nil {
		t.Fatalf(".git is gone: %v", err)
	}
}

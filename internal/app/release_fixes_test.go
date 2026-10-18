package app

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/worktree"
)

func testGit(t *testing.T, repo string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", repo}, args...)...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v: %s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

func TestMergeRefusesAnotherChannelBranch(t *testing.T) {
	f := newTaskFixture(t)
	ctx := context.Background()
	repo := filepath.Join(t.TempDir(), "repo")
	if err := os.Mkdir(repo, 0700); err != nil {
		t.Fatal(err)
	}
	testGit(t, repo, "init", "-b", "main")
	testGit(t, repo, "config", "user.name", "Test")
	testGit(t, repo, "config", "user.email", "test@example.invalid")
	if err := os.WriteFile(filepath.Join(repo, "readme"), []byte("base\n"), 0600); err != nil {
		t.Fatal(err)
	}
	testGit(t, repo, "add", "readme")
	testGit(t, repo, "commit", "-m", "base")
	f.app.Paths.WorktreesDir = filepath.Join(t.TempDir(), "trees")
	wm := worktree.Manager{BaseDir: f.app.Paths.WorktreesDir}
	w, err := wm.Create(ctx, repo, "branch-check")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = wm.Cleanup(context.Background(), w) })
	channel := f.general
	channel.RepoPath = repo
	if _, err := f.s.Append(ctx, events.Draft{Type: events.ChannelUpdated, Actor: events.System, ChannelID: channel.ID, Payload: channel}); err != nil {
		t.Fatal(err)
	}
	run := domain.Run{ID: "branch-check", ChannelID: channel.ID, Mode: domain.RunWrite, State: domain.RunWaitingApproval, Worktree: w.Path, BaseCommit: w.BaseCommit, ChannelBranch: "main"}
	if _, err := f.s.Append(ctx, events.Draft{Type: events.RunCreated, Actor: events.System, ChannelID: channel.ID, Payload: run}); err != nil {
		t.Fatal(err)
	}
	approval := domain.Approval{ID: "approval", RunID: run.ID, ChannelID: channel.ID, State: domain.ApprovalPending}
	testGit(t, repo, "switch", "-c", "feature")
	_, err = f.app.ResolveApproval(ctx, approval, "merge", "")
	var user domain.UserError
	if !errors.As(err, &user) || !strings.Contains(err.Error(), "main") || !strings.Contains(err.Error(), "feature") {
		t.Fatalf("branch change: %v", err)
	}
	if got := testGit(t, repo, "symbolic-ref", "--short", "HEAD"); got != "feature" {
		t.Fatalf("merge changed branch: %s", got)
	}
}

func TestResolveApprovalRecoversAfterRunUpdate(t *testing.T) {
	f := newTaskFixture(t)
	ctx := context.Background()
	run := domain.Run{ID: "already-merged", ChannelID: f.general.ID, Mode: domain.RunWrite, State: domain.RunDone, ApprovalOption: "merge", ApprovalOutcome: "Merged as abc123."}
	approval := domain.Approval{ID: "still-pending", RunID: run.ID, ChannelID: f.general.ID, State: domain.ApprovalPending,
		Options: []domain.ApprovalOption{{Key: "merge", Label: "Merge"}, {Key: "discard", Label: "Discard"}}}
	for _, d := range []events.Draft{
		{Type: events.RunCreated, Actor: events.System, ChannelID: f.general.ID, Payload: run},
		{Type: events.ApprovalRequested, Actor: events.System, ChannelID: f.general.ID, Payload: approval},
	} {
		if _, err := f.s.Append(ctx, d); err != nil {
			t.Fatal(err)
		}
	}
	outcome, err := f.app.ResolveApproval(ctx, approval, "merge", "")
	if err != nil || outcome != run.ApprovalOutcome {
		t.Fatalf("recover outcome: %q %v", outcome, err)
	}
	if _, err := f.s.ResolveApproval(ctx, approval.ID, "merge", outcome, f.human.ID); err != nil {
		t.Fatalf("resolve pending approval: %v", err)
	}
	if _, err := f.app.ResolveApproval(ctx, approval, "discard", ""); err == nil {
		t.Fatal("a different decision could replace the recorded one")
	}
}

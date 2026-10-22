package app

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/store"
	"github.com/thiagodefreitas/faztudo/internal/worktree"
)

func TestApprovalRuleMatcher(t *testing.T) {
	rule := domain.ApprovalRule{ChannelID: "dev", Persona: "coder", Paths: []string{"src/**"}, MaxLines: 50}
	run := domain.Run{ChannelID: "dev", Mode: domain.RunWrite, State: domain.RunWaitingApproval, Verification: &domain.Verification{OK: true}, DiffStat: &domain.DiffStat{Files: 1, Insertions: 20, Deletions: 4}}
	for _, tc := range []struct {
		name   string
		mutate func(*domain.ApprovalRule, *domain.Run, *[]changedPath)
		want   bool
	}{
		{"match", nil, true},
		{"wrong persona", func(r *domain.ApprovalRule, _ *domain.Run, _ *[]changedPath) { r.Persona = "reviewer" }, false},
		{"too many lines", func(r *domain.ApprovalRule, _ *domain.Run, _ *[]changedPath) { r.MaxLines = 23 }, false},
		{"failed checks", func(_ *domain.ApprovalRule, r *domain.Run, _ *[]changedPath) { r.Verification.OK = false }, false},
		{"protected", func(_ *domain.ApprovalRule, _ *domain.Run, files *[]changedPath) {
			*files = append(*files, changedPath{name: "src/package.json"})
		}, false},
		{"unmatched", func(_ *domain.ApprovalRule, _ *domain.Run, files *[]changedPath) {
			*files = append(*files, changedPath{name: "docs/readme.md"})
		}, false},
		{"executable", func(_ *domain.ApprovalRule, _ *domain.Run, files *[]changedPath) { (*files)[0].executable = true }, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r, v, files := rule, run, []changedPath{{name: "src/main.go"}}
			verification := *run.Verification
			v.Verification = &verification
			if tc.mutate != nil {
				tc.mutate(&r, &v, &files)
			}
			if got := approvalRuleMatches(r, v, "coder", files); got != tc.want {
				t.Fatalf("match=%v, want %v", got, tc.want)
			}
		})
	}
	for _, name := range []string{".github/workflows/ci.yml", "scripts/build.sh", "a/go.mod", "x/file.lock", ".git/config"} {
		if !protectedApprovalPath(name) {
			t.Errorf("unprotected %s", name)
		}
	}
}

func TestApprovalRuleAutoMergeAndFailedMerge(t *testing.T) {
	for _, tc := range []struct {
		name          string
		branchChanged bool
		lineCap       bool
		symlink       bool
	}{{name: "merge"}, {name: "failed merge", branchChanged: true}, {name: "fresh line cap", lineCap: true}, {name: "symlink", symlink: true}} {
		t.Run(tc.name, func(t *testing.T) {
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
			w, err := wm.Create(ctx, repo, "rule-run")
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = wm.Cleanup(context.Background(), w) })
			if err := os.Mkdir(filepath.Join(w.Path, "src"), 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(w.Path, "src", "a.go"), []byte("package src\nvar x = 1\n"), 0600); err != nil {
				t.Fatal(err)
			}
			if tc.symlink {
				if err := os.Symlink("../.github/workflows/ci.yml", filepath.Join(w.Path, "src", "ci.yml")); err != nil {
					t.Fatal(err)
				}
			}
			stat, _, err := wm.Diff(ctx, w)
			if err != nil {
				t.Fatal(err)
			}
			channel := f.general
			channel.RepoPath = repo
			if _, err := f.s.Append(ctx, events.Draft{Type: events.ChannelUpdated, Actor: events.System, ChannelID: channel.ID, Payload: channel}); err != nil {
				t.Fatal(err)
			}
			rule := domain.ApprovalRule{ID: store.NewID(), ChannelID: channel.ID, Persona: "coder", Paths: []string{"src/**"}, MaxLines: 50, CreatedBy: f.human.ID, CreatedAt: time.Now().UTC()}
			if tc.lineCap {
				rule.MaxLines = 1
			}
			if _, err := f.s.Append(ctx, events.Draft{Type: events.ApprovalRuleCreated, Actor: events.Human(f.human.ID), ChannelID: channel.ID, Payload: rule}); err != nil {
				t.Fatal(err)
			}
			if tc.branchChanged {
				testGit(t, repo, "checkout", "-b", "other")
			}
			started := time.Now().UTC()
			run := domain.Run{ID: "rule-run", ChannelID: channel.ID, TriggerMessageID: "request", AgentID: f.coder.ID, Mode: domain.RunWrite, State: domain.RunWaitingApproval, Worktree: w.Path, BaseCommit: w.BaseCommit, ChannelBranch: "main", StartedAt: &started, DiffStat: &stat, Verification: &domain.Verification{OK: true}}
			if tc.lineCap {
				run.DiffStat = &domain.DiffStat{Files: stat.Files, Insertions: 0}
			}
			if _, err := f.s.Append(ctx, events.Draft{Type: events.RunCreated, Actor: events.System, ChannelID: channel.ID, Payload: run}); err != nil {
				t.Fatal(err)
			}
			if err := f.app.postRunResult(ctx, run, domain.Message{Body: "Make change"}, f.coder, nil, false); err != nil {
				t.Fatal(err)
			}
			approvals, err := f.s.Approvals(ctx, "")
			if err != nil || len(approvals) != 1 {
				t.Fatalf("approvals %+v %v", approvals, err)
			}
			want := domain.ApprovalResolved
			if tc.branchChanged || tc.lineCap || tc.symlink {
				want = domain.ApprovalPending
			}
			if approvals[0].State != want {
				t.Fatalf("state %s, want %s", approvals[0].State, want)
			}
			if want == domain.ApprovalResolved && (approvals[0].Resolution == nil || approvals[0].Resolution.By != "system") {
				t.Fatalf("resolution %+v", approvals[0].Resolution)
			}
		})
	}
}

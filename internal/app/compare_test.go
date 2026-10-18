package app

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/adapters"
	"github.com/thiagodefreitas/faztudo/internal/config"
	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/store"
	"github.com/thiagodefreitas/faztudo/internal/worktree"
)

type compareWriteCLI struct{ prompts chan string }

func (compareWriteCLI) Name() string { return "codex" }
func (cli compareWriteCLI) Command(req adapters.Request) (adapters.Cmd, error) {
	if cli.prompts != nil {
		cli.prompts <- req.Prompt
	}
	return adapters.Cmd{Path: "/bin/sh", Args: []string{"-c", "printf 'candidate\\n' > candidate.txt; printf 'COMMIT: Add candidate\\n'"}, Dir: req.Workdir}, nil
}
func (compareWriteCLI) Classify(int, string) (domain.FailureClass, adapters.LaneSignal, string) {
	return domain.FailureUnknown, adapters.LaneSignal{Kind: adapters.SignalNone}, ""
}

func TestParseCompareRequest(t *testing.T) {
	for _, tc := range []struct {
		body, want string
		found      bool
	}{
		{"@coder x2 fix this", "@coder fix this", true},
		{"please @Coder x2 fix this", "please @Coder fix this", true},
		{"@coder fix this x2", "@coder fix this x2", false},
		{"@reviewer x2 check", "@reviewer x2 check", false},
	} {
		got, found := parseCompareRequest(tc.body, "coder")
		if strings.TrimSpace(got) != tc.want || found != tc.found {
			t.Fatalf("%q: got %q %v", tc.body, got, found)
		}
	}
}

func compareStartFixture(t *testing.T, health [3]domain.LaneHealth) (*App, *store.Store, domain.Message, domain.Member) {
	t.Helper()
	ctx := context.Background()
	s, err := store.Open(filepath.Join(t.TempDir(), "db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	agent := domain.Member{ID: "coder", Kind: domain.MemberAgent, Handle: "coder", Agent: &domain.AgentInfo{Lanes: []string{"a", "b", "c"}, Mode: domain.RunWrite}}
	channel := domain.Channel{ID: "work", Name: "work", RepoPath: "/fixture/repo", Visibility: domain.VisibilityPublic}
	m := domain.Message{ID: "request", ChannelID: channel.ID, Body: "@coder x2 change it", AuthorID: "human"}
	human := domain.Member{ID: "human", Kind: domain.MemberHuman, Handle: "ada"}
	drafts := []events.Draft{{Type: events.MemberUpdated, Payload: human}, {Type: events.MemberUpdated, Payload: agent}, {Type: events.ChannelCreated, ChannelID: channel.ID, Payload: channel}, {Type: events.MessagePosted, ChannelID: channel.ID, Payload: m}}
	for i, id := range []string{"a", "b", "c"} {
		drafts = append(drafts, events.Draft{Type: events.LaneUpdated, Payload: domain.Lane{ID: id, CLI: "codex", Capacity: 1, Health: health[i], Windows: []domain.LaneWindow{}}})
	}
	for _, d := range drafts {
		d.Actor = events.System
		if _, err := s.Append(ctx, d); err != nil {
			t.Fatal(err)
		}
	}
	a, err := New(ctx, s, config.Config{}, config.Paths{})
	if err != nil {
		t.Fatal(err)
	}
	return a, s, m, agent
}

func TestCompareStartsTwoHealthyLanes(t *testing.T) {
	a, s, m, agent := compareStartFixture(t, [3]domain.LaneHealth{domain.LaneAvailable, domain.LaneAvailable, domain.LaneAvailable})
	called := make(chan string, 2)
	a.compareDispatch = func(_ context.Context, _ domain.Message, _ domain.Member, lane string) error {
		called <- lane
		return nil
	}
	a.OnMessage(context.Background(), m, []domain.Member{agent})
	got := map[string]bool{}
	for i := 0; i < 2; i++ {
		select {
		case lane := <-called:
			got[lane] = true
		case <-time.After(time.Second):
			t.Fatal("candidate did not start")
		}
	}
	if !got["a"] || !got["b"] || got["c"] {
		t.Fatalf("chosen lanes: %v", got)
	}
	groups, err := a.CompareList(context.Background(), m.ChannelID)
	if err != nil || len(groups) != 1 || groups[0].Candidates[0].LaneID != "a" || groups[0].Candidates[1].LaneID != "b" {
		t.Fatalf("stored group: %+v %v", groups, err)
	}
	if runs, err := s.Runs(context.Background(), m.ChannelID, ""); err != nil || len(runs) != 0 {
		t.Fatalf("fake dispatch should leave no runs: %+v %v", runs, err)
	}
}

func TestCompareRecoveryMarksCandidatesMissingAfterRestart(t *testing.T) {
	a, s, m, agent := compareStartFixture(t, [3]domain.LaneHealth{domain.LaneAvailable, domain.LaneAvailable, domain.LaneAvailable})
	group := events.CompareStartedPayload{ID: "recovery", ChannelID: m.ChannelID, MessageID: m.ID, AgentID: agent.ID, Lanes: [2]string{"a", "b"}}
	if _, err := s.Append(context.Background(), events.Draft{Type: events.CompareStarted, Actor: events.System, ChannelID: m.ChannelID, Payload: group}); err != nil {
		t.Fatal(err)
	}
	if err := a.recoverCompares(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := a.recoverCompares(context.Background()); err != nil {
		t.Fatal(err)
	}
	runs, err := s.Runs(context.Background(), m.ChannelID, "")
	if err != nil || len(runs) != 2 {
		t.Fatalf("recovery duplicated or missed candidates: %+v %v", runs, err)
	}
	for _, run := range runs {
		if run.State != domain.RunFailed || !strings.Contains(run.FailureReason, "before the candidate started") {
			t.Fatalf("candidate recovery: %+v", run)
		}
	}
}

func TestCompareRefusesOneLaneAndSkipsConserve(t *testing.T) {
	for _, tc := range []struct {
		name   string
		health [3]domain.LaneHealth
		want   []string
	}{
		{"one healthy", [3]domain.LaneHealth{domain.LaneAvailable, domain.LaneExhausted, domain.LaneConserve}, nil},
		{"conserve skipped", [3]domain.LaneHealth{domain.LaneConserve, domain.LaneAvailable, domain.LaneAvailable}, []string{"b", "c"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a, s, m, agent := compareStartFixture(t, tc.health)
			called := make(chan string, 2)
			a.compareDispatch = func(_ context.Context, _ domain.Message, _ domain.Member, lane string) error {
				called <- lane
				return nil
			}
			a.OnMessage(context.Background(), m, []domain.Member{agent})
			groups, err := a.CompareList(context.Background(), m.ChannelID)
			if err != nil {
				t.Fatal(err)
			}
			if tc.want == nil {
				if len(groups) != 0 || len(called) != 0 || !noticeContaining(t, s, m.ChannelID, "needs two healthy lanes") || !noticeContaining(t, s, m.ChannelID, "b is exhausted") || !noticeContaining(t, s, m.ChannelID, "c is conserve") {
					t.Fatalf("one healthy lane started or lacked notice: %+v", groups)
				}
				return
			}
			if len(groups) != 1 || groups[0].Candidates[0].LaneID != tc.want[0] || groups[0].Candidates[1].LaneID != tc.want[1] {
				t.Fatalf("conserve selection: %+v", groups)
			}
		})
	}
}

func TestCompareCandidatesUseSeparateWorktrees(t *testing.T) {
	_, s, m, agent := compareStartFixture(t, [3]domain.LaneHealth{domain.LaneAvailable, domain.LaneAvailable, domain.LaneAvailable})
	ctx := context.Background()
	repo := filepath.Join(t.TempDir(), "repo")
	if err := os.Mkdir(repo, 0700); err != nil {
		t.Fatal(err)
	}
	testGit(t, repo, "init", "-b", "main")
	testGit(t, repo, "config", "user.name", "Test")
	testGit(t, repo, "config", "user.email", "test@example.invalid")
	if err := os.WriteFile(filepath.Join(repo, "base"), []byte("base\n"), 0600); err != nil {
		t.Fatal(err)
	}
	testGit(t, repo, "add", "base")
	testGit(t, repo, "commit", "-m", "base")
	channel, err := s.Channel(ctx, m.ChannelID)
	if err != nil {
		t.Fatal(err)
	}
	channel.RepoPath = repo
	if _, err := s.Append(ctx, events.Draft{Type: events.ChannelUpdated, Actor: events.System, ChannelID: channel.ID, Payload: channel}); err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	cfg := config.Defaults()
	cfg.Runs.Sandbox = "off"
	a, err := New(ctx, s, cfg, config.Paths{DataDir: root, RunsDir: filepath.Join(root, "runs"), WorktreesDir: filepath.Join(root, "trees")})
	if err != nil {
		t.Fatal(err)
	}
	prompts := make(chan string, 2)
	a.Adapters["codex"] = compareWriteCLI{prompts: prompts}
	a.OnMessage(ctx, m, []domain.Member{agent})
	deadline := time.Now().Add(5 * time.Second)
	for {
		runs, err := s.Runs(ctx, m.ChannelID, "")
		if err != nil {
			t.Fatal(err)
		}
		if len(runs) == 2 && runs[0].State == domain.RunWaitingApproval && runs[1].State == domain.RunWaitingApproval {
			if runs[0].ID == runs[1].ID || runs[0].Worktree == runs[1].Worktree || runs[0].Worktree == "" || runs[1].Worktree == "" {
				t.Fatalf("candidates shared a worktree: %+v", runs)
			}
			for _, run := range runs {
				if _, err := os.Stat(filepath.Join(run.Worktree, "candidate.txt")); err != nil {
					t.Fatalf("candidate %s: %v", run.ID, err)
				}
			}
			first, second := <-prompts, <-prompts
			if first != second || strings.Contains(first, "@coder x2") || !strings.Contains(first, "@coder change it") {
				t.Fatalf("candidates received different requests: %q / %q", first, second)
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("candidate runs did not finish: %+v", runs)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func compareDecisionFixture(t *testing.T) (*App, *store.Store, string, [2]domain.Run) {
	t.Helper()
	f := newTaskFixture(t)
	ctx := context.Background()
	repo := filepath.Join(t.TempDir(), "repo")
	if err := os.Mkdir(repo, 0700); err != nil {
		t.Fatal(err)
	}
	testGit(t, repo, "init", "-b", "main")
	testGit(t, repo, "config", "user.name", "Test")
	testGit(t, repo, "config", "user.email", "test@example.invalid")
	if err := os.WriteFile(filepath.Join(repo, "base"), []byte("base\n"), 0600); err != nil {
		t.Fatal(err)
	}
	testGit(t, repo, "add", "base")
	testGit(t, repo, "commit", "-m", "base")
	channel := f.general
	channel.RepoPath = repo
	if _, err := f.s.Append(ctx, events.Draft{Type: events.ChannelUpdated, Actor: events.System, ChannelID: channel.ID, Payload: channel}); err != nil {
		t.Fatal(err)
	}
	f.app.Paths.WorktreesDir = filepath.Join(t.TempDir(), "trees")
	f.app.Paths.RunsDir = filepath.Join(t.TempDir(), "runs")
	wm := worktree.Manager{BaseDir: f.app.Paths.WorktreesDir}
	var runs [2]domain.Run
	for i, lane := range []string{"a", "b"} {
		id := "compare-" + lane
		w, err := wm.Create(ctx, repo, id)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = wm.Cleanup(context.Background(), w) })
		if err := os.WriteFile(filepath.Join(w.Path, lane+".txt"), []byte(lane+"\n"), 0600); err != nil {
			t.Fatal(err)
		}
		runs[i] = domain.Run{ID: id, ChannelID: channel.ID, TriggerMessageID: "request", AgentID: f.coder.ID, LaneID: lane, Mode: domain.RunWrite, State: domain.RunWaitingApproval, Worktree: w.Path, BaseCommit: w.BaseCommit, ChannelBranch: "main", DiffStat: &domain.DiffStat{Files: 1, Insertions: 1}}
		if _, err := f.s.Append(ctx, events.Draft{Type: events.RunCreated, Actor: events.System, ChannelID: channel.ID, Payload: runs[i]}); err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(filepath.Join(f.app.Paths.RunsDir, id), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(f.app.Paths.RunsDir, id, "diff.patch"), []byte("diff --git a/"+lane+".txt b/"+lane+".txt\n"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	group := events.CompareStartedPayload{ID: "comparison", ChannelID: channel.ID, MessageID: "request", AgentID: f.coder.ID, Lanes: [2]string{"a", "b"}}
	if _, err := f.s.Append(ctx, events.Draft{Type: events.CompareStarted, Actor: events.System, ChannelID: channel.ID, Payload: group}); err != nil {
		t.Fatal(err)
	}
	return f.app, f.s, repo, runs
}

func TestCompareMergeDiscardsOtherAndRecordsWinner(t *testing.T) {
	a, s, repo, runs := compareDecisionFixture(t)
	group, err := a.CompareDecide(context.Background(), runs[0].ChannelID, "comparison", "merge_a", "ada")
	if err != nil {
		t.Fatal(err)
	}
	if group.WinnerLane != "a" || group.Decision != "merge_a" {
		t.Fatalf("decision: %+v", group)
	}
	if _, err := os.Stat(filepath.Join(repo, "a.txt")); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(repo, "b.txt")); !os.IsNotExist(err) {
		t.Fatalf("losing file reached repo: %v", err)
	}
	if _, err := os.Stat(runs[1].Worktree); !os.IsNotExist(err) {
		t.Fatalf("losing worktree remains: %v", err)
	}
	stored, err := s.Run(context.Background(), runs[1].ID)
	if err != nil || stored.ApprovalOption != "discard" {
		t.Fatalf("loser: %+v %v", stored, err)
	}
	groups, err := a.CompareList(context.Background(), runs[0].ChannelID)
	if err != nil || len(groups) != 1 || groups[0].Decision != "merge_a" || groups[0].WinnerLane != "a" {
		t.Fatalf("event replay: %+v %v", groups, err)
	}
}

func TestCompareMergeDiscardsFailedCandidateWorktree(t *testing.T) {
	a, s, _, runs := compareDecisionFixture(t)
	failed := runs[1]
	failed.State = domain.RunFailed
	if _, err := s.Append(context.Background(), events.Draft{Type: events.RunUpdated, Actor: events.System, ChannelID: failed.ChannelID, Payload: failed}); err != nil {
		t.Fatal(err)
	}
	if _, err := a.CompareDecide(context.Background(), failed.ChannelID, "comparison", "merge_a", "ada"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(failed.Worktree); !os.IsNotExist(err) {
		t.Fatalf("failed loser worktree remains: %v", err)
	}
}

func TestCompareCannotChangeChoiceAfterPartialMerge(t *testing.T) {
	a, s, _, runs := compareDecisionFixture(t)
	approval := domain.Approval{RunID: runs[0].ID, ChannelID: runs[0].ChannelID}
	if _, err := a.ResolveApproval(context.Background(), approval, "merge", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := a.CompareDecide(context.Background(), runs[0].ChannelID, "comparison", "merge_b", "ada"); err == nil {
		t.Fatal("allowed a different winner after a partial merge")
	}
	other, err := s.Run(context.Background(), runs[1].ID)
	if err != nil || other.State != domain.RunWaitingApproval {
		t.Fatalf("other candidate changed: %+v %v", other, err)
	}
}

func TestCompareRetriesAfterWorktreeCleanupBeforeRunUpdate(t *testing.T) {
	a, s, repo, runs := compareDecisionFixture(t)
	wm := worktree.Manager{BaseDir: a.Paths.WorktreesDir}
	w, err := wm.Open(context.Background(), repo, runs[1].Worktree, "fz/"+runs[1].ID, runs[1].BaseCommit)
	if err != nil {
		t.Fatal(err)
	}
	if err := wm.Cleanup(context.Background(), w); err != nil {
		t.Fatal(err)
	}
	if _, err := a.CompareDecide(context.Background(), runs[0].ChannelID, "comparison", "discard_both", "ada"); err != nil {
		t.Fatal(err)
	}
	loser, err := s.Run(context.Background(), runs[1].ID)
	if err != nil || loser.ApprovalOption != "discard" || loser.Worktree != "" {
		t.Fatalf("stale run did not recover: %+v %v", loser, err)
	}
}

func TestCompareCombineStartsThirdRunWithBothDiffs(t *testing.T) {
	a, s, _, runs := compareDecisionFixture(t)
	members, err := s.Members(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, member := range members {
		if member.ID == "coder" {
			member.Agent.Mode = domain.RunWrite
			if _, err := s.Append(context.Background(), events.Draft{Type: events.MemberUpdated, Actor: events.System, Payload: member}); err != nil {
				t.Fatal(err)
			}
		}
	}
	started := make(chan string, 1)
	a.compareDispatch = func(ctx context.Context, m domain.Message, _ domain.Member, lane string) error {
		if lane != "" {
			t.Errorf("combine was pinned to %s", lane)
		}
		_, err := s.Append(ctx, events.Draft{Type: events.RunCreated, Actor: events.System, ChannelID: m.ChannelID, Payload: domain.Run{ID: "combined-run", ChannelID: m.ChannelID, TriggerMessageID: m.ID, AgentID: "coder", LaneID: "a", Mode: domain.RunWrite, State: domain.RunQueued}})
		if err != nil {
			return err
		}
		started <- a.extraContext(m.ID)
		return nil
	}
	group, err := a.CompareDecide(context.Background(), runs[0].ChannelID, "comparison", "combine", "ada")
	if err != nil || group.Decision != "combine" {
		t.Fatalf("combine: %+v %v", group, err)
	}
	select {
	case prompt := <-started:
		if !strings.Contains(prompt, "a.txt") || !strings.Contains(prompt, "b.txt") {
			t.Fatalf("both diffs missing: %q", prompt)
		}
		all, err := s.Runs(context.Background(), runs[0].ChannelID, "")
		if err != nil || len(all) != 3 {
			t.Fatalf("third run missing: %+v %v", all, err)
		}
	case <-time.After(time.Second):
		t.Fatal("third run did not start")
	}
}

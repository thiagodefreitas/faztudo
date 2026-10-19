package app

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/adapters"
	"github.com/thiagodefreitas/faztudo/internal/config"
	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/runner"
	"github.com/thiagodefreitas/faztudo/internal/store"
	"github.com/thiagodefreitas/faztudo/internal/tasks"
	"github.com/thiagodefreitas/faztudo/internal/worktree"
)

type recoveredSignalAdapter struct{}

func (recoveredSignalAdapter) Name() string { return "codex" }
func (recoveredSignalAdapter) Command(adapters.Request) (adapters.Cmd, error) {
	return adapters.Cmd{}, nil
}
func (recoveredSignalAdapter) Classify(int, string) (domain.FailureClass, adapters.LaneSignal, string) {
	return domain.FailureSemantic, adapters.LaneSignal{Kind: adapters.SignalExhausted}, "quota exhausted"
}

func TestRecoveredWritePostsAnswerAndApproval(t *testing.T) {
	ctx := context.Background()
	f := newRoutineFixture(t, config.Defaults(), domain.LaneAvailable, "")
	root := t.TempDir()
	f.app.Paths.RunsDir = filepath.Join(root, "runs")
	f.app.Paths.WorktreesDir = filepath.Join(root, "trees")
	f.app.Runner.RunDir = f.app.Paths.RunsDir
	f.app.Config.Runs.Sandbox = "off"
	repo := filepath.Join(root, "repo")
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
	ch := f.general
	ch.RepoPath = repo
	if _, err := f.s.Append(ctx, events.Draft{Type: events.ChannelUpdated, Actor: events.System, ChannelID: ch.ID, Payload: ch}); err != nil {
		t.Fatal(err)
	}
	m := domain.Message{ID: "message", ChannelID: ch.ID, AuthorID: f.human.ID, Body: "@coder add a file", CreatedAt: time.Now().UTC()}
	if _, err := f.s.Append(ctx, events.Draft{Type: events.MessagePosted, Actor: events.Human(f.human.ID), ChannelID: ch.ID, Payload: m}); err != nil {
		t.Fatal(err)
	}
	wm := worktree.Manager{BaseDir: f.app.Paths.WorktreesDir}
	w, err := wm.Create(ctx, repo, "recovered-write")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = wm.Cleanup(context.Background(), w) })
	if err := os.WriteFile(filepath.Join(w.Path, "answer.txt"), []byte("answer\n"), 0600); err != nil {
		t.Fatal(err)
	}
	started := time.Now().Add(-time.Second)
	run := domain.Run{ID: "recovered-write", ChannelID: ch.ID, TriggerMessageID: m.ID, AgentID: f.coder.ID, LaneID: "a", Mode: domain.RunWrite, State: domain.RunRunning, Worktree: w.Path, BaseCommit: w.BaseCommit, StartedAt: &started}
	if _, err := f.s.Append(ctx, events.Draft{Type: events.RunCreated, Actor: events.System, ChannelID: ch.ID, Payload: run}); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(f.app.Paths.RunsDir, run.ID)
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	metadata, _ := json.Marshal(runner.Metadata{Run: run, PendingFinalization: true})
	for name, data := range map[string][]byte{"run.json": metadata, "exit.status": []byte("0\n"), "stdout.log": []byte("I made the file.\n\nCOMMIT: Add answer file\n")} {
		if err := os.WriteFile(filepath.Join(dir, name), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := f.app.Runner.Recover(ctx); err != nil {
		t.Fatal(err)
	}
	f.app.Runner.WaitRecovered()
	got, err := f.s.Run(ctx, run.ID)
	if err != nil || got.State != domain.RunWaitingApproval || got.Verification == nil || !got.Verification.OK || got.DiffStat == nil || got.DiffStat.Files != 1 {
		t.Fatalf("recovered run: %+v %v", got, err)
	}
	approvals, _ := f.s.Approvals(ctx, "")
	if len(approvals) != 1 || approvals[0].RunID != run.ID {
		t.Fatalf("approvals: %+v", approvals)
	}
	messages, _ := f.s.Messages(ctx, ch.ID, "", 20)
	found := false
	for _, reply := range messages {
		found = found || reply.RunID == run.ID && reply.Body == "I made the file."
	}
	if !found {
		t.Fatalf("missing answer: %+v", messages)
	}
	if _, err := f.app.Runner.Recover(ctx); err != nil {
		t.Fatal(err)
	}
	again, _ := f.s.Approvals(ctx, "")
	if len(again) != 1 {
		t.Fatalf("duplicate approval: %+v", again)
	}
	// The terminal event may have reached the store just before a crash,
	// while the approval append never ran.
	w2, err := wm.Create(ctx, repo, "pending-approval")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = wm.Cleanup(context.Background(), w2) })
	if err := os.WriteFile(filepath.Join(w2.Path, "second.txt"), []byte("second\n"), 0600); err != nil {
		t.Fatal(err)
	}
	second := domain.Run{ID: "pending-approval", ChannelID: ch.ID, TriggerMessageID: m.ID, AgentID: f.coder.ID, LaneID: "a", Mode: domain.RunWrite, State: domain.RunWaitingApproval, Worktree: w2.Path, BaseCommit: w2.BaseCommit, StartedAt: &started, EndedAt: &started, DiffStat: &domain.DiffStat{Files: 1}}
	if _, err := f.s.Append(ctx, events.Draft{Type: events.RunCreated, Actor: events.System, ChannelID: ch.ID, Payload: second}); err != nil {
		t.Fatal(err)
	}
	secondDir := filepath.Join(f.app.Paths.RunsDir, second.ID)
	if err := os.MkdirAll(secondDir, 0700); err != nil {
		t.Fatal(err)
	}
	metadata, _ = json.Marshal(runner.Metadata{Run: second, PendingFinalization: true})
	for name, data := range map[string][]byte{"run.json": metadata, "stdout.log": []byte("Second answer.\n")} {
		if err := os.WriteFile(filepath.Join(secondDir, name), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := f.app.Runner.Recover(ctx); err != nil {
		t.Fatal(err)
	}
	approvals, _ = f.s.Approvals(ctx, "")
	if len(approvals) != 2 {
		t.Fatalf("missing approval after terminal event: %+v", approvals)
	}
	// The metadata may be terminal even when the terminal event failed.
	third := domain.Run{ID: "missing-terminal-event", ChannelID: ch.ID, TriggerMessageID: m.ID, AgentID: f.coder.ID, LaneID: "a", Mode: domain.RunRead, State: domain.RunRunning, StartedAt: &started}
	if _, err := f.s.Append(ctx, events.Draft{Type: events.RunCreated, Actor: events.System, ChannelID: ch.ID, Payload: third}); err != nil {
		t.Fatal(err)
	}
	thirdDir := filepath.Join(f.app.Paths.RunsDir, third.ID)
	if err := os.MkdirAll(thirdDir, 0700); err != nil {
		t.Fatal(err)
	}
	third.State, third.EndedAt = domain.RunDone, &started
	metadata, _ = json.Marshal(runner.Metadata{Run: third, PendingFinalization: true})
	for name, data := range map[string][]byte{"run.json": metadata, "stdout.log": []byte("Recovered answer.\n")} {
		if err := os.WriteFile(filepath.Join(thirdDir, name), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := f.app.Runner.Recover(ctx); err != nil {
		t.Fatal(err)
	}
	stored, err := f.s.Run(ctx, third.ID)
	if err != nil || stored.State != domain.RunDone {
		t.Fatalf("terminal projection: %+v %v", stored, err)
	}
	// Without an exit file, the result is unknown. The task still finishes
	// and the failed candidate's worktree is removed.
	w4, err := wm.Create(ctx, repo, "unknown-exit")
	if err != nil {
		t.Fatal(err)
	}
	taskMessage := domain.Message{ID: "task-message", ChannelID: ch.ID, AuthorID: f.human.ID, Body: "@coder do task", CreatedAt: time.Now().UTC()}
	if _, err := f.s.Append(ctx, events.Draft{Type: events.MessagePosted, Actor: events.Human(f.human.ID), ChannelID: ch.ID, Payload: taskMessage}); err != nil {
		t.Fatal(err)
	}
	task := domain.Task{ID: "task", ChannelID: ch.ID, Title: "Recover task", Assignee: f.coder.Handle, Mode: domain.RunWrite, Status: domain.TaskRunning, MessageID: taskMessage.ID, CreatedAt: started, UpdatedAt: started}
	if _, err := f.s.Append(ctx, events.Draft{Type: events.TaskCreated, Actor: events.System, ChannelID: ch.ID, Payload: task}); err != nil {
		t.Fatal(err)
	}
	fourth := domain.Run{ID: "unknown-exit", ChannelID: ch.ID, TriggerMessageID: taskMessage.ID, AgentID: f.coder.ID, LaneID: "a", Mode: domain.RunWrite, State: domain.RunRunning, Worktree: w4.Path, BaseCommit: w4.BaseCommit, StartedAt: &started}
	if _, err := f.s.Append(ctx, events.Draft{Type: events.RunCreated, Actor: events.System, ChannelID: ch.ID, Payload: fourth}); err != nil {
		t.Fatal(err)
	}
	fourthDir := filepath.Join(f.app.Paths.RunsDir, fourth.ID)
	if err := os.MkdirAll(fourthDir, 0700); err != nil {
		t.Fatal(err)
	}
	metadata, _ = json.Marshal(runner.Metadata{Run: fourth, PendingFinalization: true})
	if err := os.WriteFile(filepath.Join(fourthDir, "run.json"), metadata, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := f.app.Runner.Recover(ctx); err != nil {
		t.Fatal(err)
	}
	failed, err := f.s.Run(ctx, fourth.ID)
	if err != nil || failed.State != domain.RunFailed || failed.FailureReason != "outcome unknown after daemon restart" {
		t.Fatalf("unknown result: %+v %v", failed, err)
	}
	if _, err := os.Stat(w4.Path); !os.IsNotExist(err) {
		t.Fatalf("failed worktree remains: %v", err)
	}
	updatedTask, err := f.s.Task(ctx, task.ID)
	if err != nil || updatedTask.Status != domain.TaskFailed {
		t.Fatalf("task stayed active: %+v %v", updatedTask, err)
	}
	// A crash between cleanup and its marker must be safe to replay.
	b, err := os.ReadFile(filepath.Join(fourthDir, "run.json"))
	if err != nil {
		t.Fatal(err)
	}
	var retry runner.Metadata
	if err := json.Unmarshal(b, &retry); err != nil {
		t.Fatal(err)
	}
	retry.PendingFinalization = true
	b, _ = json.Marshal(retry)
	if err := os.WriteFile(filepath.Join(fourthDir, "run.json"), b, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := f.app.Runner.Recover(ctx); err != nil {
		t.Fatalf("replay after cleanup: %v", err)
	}
}

func TestQueuedRunsRestartInOrder(t *testing.T) {
	f := newRoutineFixture(t, config.Defaults(), domain.LaneAvailable, "")
	f.app.Paths.RunsDir = t.TempDir()
	f.app.Runner.RunDir = f.app.Paths.RunsDir
	ctx := context.Background()
	for _, id := range []string{"first", "second"} {
		m := domain.Message{ID: id, ChannelID: f.general.ID, AuthorID: f.human.ID, Body: "@coder do " + id, CreatedAt: time.Now().UTC()}
		if _, err := f.s.Append(ctx, events.Draft{Type: events.MessagePosted, Actor: events.Human(f.human.ID), ChannelID: m.ChannelID, Payload: m}); err != nil {
			t.Fatal(err)
		}
		if _, err := f.app.queueRun(ctx, m, f.coder, domain.RunRead, "", "", false); err != nil {
			t.Fatal(err)
		}
	}
	started := make(chan string, 2)
	release := make(chan struct{})
	f.app.queuedDispatch = func(_ context.Context, m domain.Message, _ domain.Member, _ string) {
		started <- m.ID
		if m.ID == "first" {
			<-release
		}
	}
	if err := f.app.recoverQueued(ctx); err != nil {
		t.Fatal(err)
	}
	if first := <-started; first != "first" {
		t.Fatalf("first dispatch = %s", first)
	}
	select {
	case second := <-started:
		t.Fatalf("second dispatch %s overtook first", second)
	case <-time.After(30 * time.Millisecond):
	}
	close(release)
	select {
	case second := <-started:
		if second != "second" {
			t.Fatalf("second dispatch = %s", second)
		}
	case <-time.After(time.Second):
		t.Fatal("second dispatch did not start")
	}
}

func TestRecoveredQueueKeepsLaneOverrideOutOfPrompt(t *testing.T) {
	f := newRoutineFixture(t, config.Defaults(), domain.LaneAvailable, "")
	f.app.Paths.RunsDir = t.TempDir()
	f.app.Runner.RunDir = f.app.Paths.RunsDir
	ctx := context.Background()
	m := domain.Message{ID: "override", ChannelID: f.general.ID, AuthorID: f.human.ID, Body: "@coder /lane a do this", CreatedAt: time.Now().UTC()}
	if _, err := f.s.Append(ctx, events.Draft{Type: events.MessagePosted, Actor: events.Human(f.human.ID), ChannelID: m.ChannelID, Payload: m}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.app.queueRun(ctx, m, f.coder, domain.RunRead, "a", "", false); err != nil {
		t.Fatal(err)
	}
	got := make(chan domain.Message, 1)
	f.app.queuedDispatch = func(_ context.Context, m domain.Message, _ domain.Member, override string) {
		if override == "a" {
			got <- m
		}
	}
	if err := f.app.recoverQueued(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case recovered := <-got:
		if recovered.Body != "@coder do this" {
			t.Fatalf("recovered body: %q", recovered.Body)
		}
	case <-time.After(time.Second):
		t.Fatal("queue was not dispatched")
	}
}

func TestOnMessagePersistsQueueBeforeDispatch(t *testing.T) {
	f := newRoutineFixture(t, config.Defaults(), domain.LaneAvailable, "")
	ctx := context.Background()
	f.app.queuedDispatch = func(context.Context, domain.Message, domain.Member, string) {}
	m := domain.Message{ID: "queued-message", ChannelID: f.general.ID, AuthorID: f.human.ID, Body: "@coder do this", CreatedAt: time.Now().UTC()}
	if _, err := f.s.Append(ctx, events.Draft{Type: events.MessagePosted, Actor: events.Human(f.human.ID), ChannelID: m.ChannelID, Payload: m}); err != nil {
		t.Fatal(err)
	}
	f.app.OnMessage(ctx, m, []domain.Member{f.coder})
	runs, err := f.s.Runs(ctx, m.ChannelID, string(domain.RunQueued))
	if err != nil || len(runs) != 1 || runs[0].TriggerMessageID != m.ID {
		t.Fatalf("queued before dispatch: %+v %v", runs, err)
	}
}

func TestStartTaskPersistsQueueBeforeDispatch(t *testing.T) {
	f := newTaskFixture(t)
	f.holdUntil = make(chan struct{})
	task := f.create(t, tasks.Input{Title: "Wait for a lane", Assignee: "coder"})
	started, err := f.app.StartTask(context.Background(), f.human, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	runs, err := f.s.Runs(context.Background(), started.ChannelID, string(domain.RunQueued))
	if err != nil || len(runs) != 1 || runs[0].TriggerMessageID != started.MessageID {
		t.Fatalf("task queue: %+v %v", runs, err)
	}
	close(f.holdUntil)
	f.waitStatus(t, task.ID, domain.TaskDone)
}

func TestQueuedRunCanBeCancelledBeforeLaneFrees(t *testing.T) {
	f := newRoutineFixture(t, config.Defaults(), domain.LaneAvailable, "")
	ctx := context.Background()
	m := domain.Message{ID: "cancel-queued", ChannelID: f.general.ID, AuthorID: f.human.ID, Body: "@coder wait", CreatedAt: time.Now().UTC()}
	if _, err := f.s.Append(ctx, events.Draft{Type: events.MessagePosted, Actor: events.Human(f.human.ID), ChannelID: m.ChannelID, Payload: m}); err != nil {
		t.Fatal(err)
	}
	if err := f.app.Registry.Acquire("a"); err != nil {
		t.Fatal(err)
	}
	defer f.app.Registry.Release("a")
	done := make(chan error, 1)
	go func() { done <- f.app.attempt(ctx, m, f.coder, "", "", new(string), false, "") }()
	var queued domain.Run
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		runs, _ := f.s.Runs(ctx, m.ChannelID, string(domain.RunQueued))
		if len(runs) == 1 {
			queued = runs[0]
			break
		}
		time.Sleep(time.Millisecond)
	}
	if queued.ID == "" {
		t.Fatal("run was not queued")
	}
	if err := f.app.CancelRun(ctx, queued.ID); err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("queued run did not stop")
	}
	got, err := f.s.Run(ctx, queued.ID)
	if err != nil || got.State != domain.RunCancelled {
		t.Fatalf("cancelled queue: %+v %v", got, err)
	}
}

func TestRecoveredQueueWaitsConcurrentlyAfterOrderedDispatch(t *testing.T) {
	f := newRoutineFixture(t, config.Defaults(), domain.LaneAvailable, "")
	f.app.Paths.RunsDir = t.TempDir()
	f.app.Runner.RunDir = f.app.Paths.RunsDir
	ctx := context.Background()
	var ids []string
	for _, id := range []string{"wait-one", "wait-two"} {
		m := domain.Message{ID: id, ChannelID: f.general.ID, AuthorID: f.human.ID, Body: "@coder wait", CreatedAt: time.Now().UTC()}
		if _, err := f.s.Append(ctx, events.Draft{Type: events.MessagePosted, Actor: events.Human(f.human.ID), ChannelID: m.ChannelID, Payload: m}); err != nil {
			t.Fatal(err)
		}
		run, err := f.app.queueRun(ctx, m, f.coder, domain.RunRead, "", "", false)
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, run.ID)
	}
	if err := f.app.Registry.Acquire("a"); err != nil {
		t.Fatal(err)
	}
	defer f.app.Registry.Release("a")
	if err := f.app.recoverQueued(ctx); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		f.app.activeMu.Lock()
		active := len(f.app.active)
		f.app.activeMu.Unlock()
		if active == 2 {
			break
		}
		time.Sleep(time.Millisecond)
	}
	f.app.activeMu.Lock()
	active := len(f.app.active)
	f.app.activeMu.Unlock()
	for _, id := range ids {
		if err := f.app.CancelRun(ctx, id); err != nil {
			t.Fatal(err)
		}
	}
	if active != 2 {
		t.Fatalf("only %d queued runs reached lane wait", active)
	}
	deadline = time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		f.app.activeMu.Lock()
		remaining := len(f.app.active)
		f.app.activeMu.Unlock()
		if remaining == 0 {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("cancelled queue dispatches did not finish")
}

func TestApprovalWaitsForTerminalProjection(t *testing.T) {
	f := newRoutineFixture(t, config.Defaults(), domain.LaneAvailable, "")
	ctx := context.Background()
	m := domain.Message{ID: "terminal-gate", ChannelID: f.general.ID, AuthorID: f.human.ID, Body: "@coder change it", CreatedAt: time.Now().UTC()}
	if _, err := f.s.Append(ctx, events.Draft{Type: events.MessagePosted, Actor: events.Human(f.human.ID), ChannelID: m.ChannelID, Payload: m}); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	run := domain.Run{ID: "missing-final-event", ChannelID: m.ChannelID, TriggerMessageID: m.ID, AgentID: f.coder.ID, LaneID: "a", Mode: domain.RunWrite, State: domain.RunWaitingApproval, StartedAt: &now, EndedAt: &now, DiffStat: &domain.DiffStat{Files: 1}}
	stored := run
	stored.State, stored.EndedAt = domain.RunRunning, nil
	if _, err := f.s.Append(ctx, events.Draft{Type: events.RunCreated, Actor: events.System, ChannelID: m.ChannelID, Payload: stored}); err != nil {
		t.Fatal(err)
	}
	if err := f.app.postRunResult(ctx, run, m, f.coder, adapters.Codex{}, false); err == nil {
		t.Fatal("approval was posted before the final run event")
	}
	approvals, err := f.s.Approvals(ctx, "")
	if err != nil || len(approvals) != 0 {
		t.Fatalf("premature approval: %+v %v", approvals, err)
	}
}

func TestRecoveredZeroExitStillAppliesLaneSignal(t *testing.T) {
	f := newRoutineFixture(t, config.Defaults(), domain.LaneAvailable, "")
	f.app.Adapters["codex"] = recoveredSignalAdapter{}
	run := domain.Run{ID: "zero-exhausted", ChannelID: f.general.ID, AgentID: f.coder.ID, LaneID: "a", Mode: domain.RunRead}
	state, class, reason, err := f.app.recoveredOutcome(context.Background(), &run, 0)
	if err != nil || state != domain.RunFailed || class != domain.FailureSemantic || reason != "quota exhausted" {
		t.Fatalf("outcome: %s %s %q %v", state, class, reason, err)
	}
	lane, _ := f.app.Registry.Snapshot("a")
	if lane.Health != domain.LaneExhausted {
		t.Fatalf("lane health: %+v", lane)
	}
}

func TestWriteWithoutRepositoryDoesNotLeaveQueuedRun(t *testing.T) {
	f := newRoutineFixture(t, config.Defaults(), domain.LaneAvailable, "")
	f.app.queuedDispatch = func(context.Context, domain.Message, domain.Member, string) {}
	agent := f.coder
	agent.Agent = &domain.AgentInfo{Lanes: []string{"a"}, Mode: domain.RunWrite}
	m := domain.Message{ID: "no-repo", ChannelID: f.general.ID, AuthorID: f.human.ID, Body: "@coder change it", CreatedAt: time.Now().UTC()}
	f.app.OnMessage(context.Background(), m, []domain.Member{agent})
	runs, err := f.s.Runs(context.Background(), m.ChannelID, "")
	if err != nil || len(runs) != 0 {
		t.Fatalf("run persisted without repository: %+v %v", runs, err)
	}
	queued, err := f.app.queueRun(context.Background(), m, agent, domain.RunWrite, "", "", false)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.app.execute(context.Background(), m, agent, ""); err != nil {
		t.Fatal(err)
	}
	stopped, err := f.s.Run(context.Background(), queued.ID)
	if err != nil || stopped.State != domain.RunFailed {
		t.Fatalf("queued write after repository removal: %+v %v", stopped, err)
	}
}

func TestCancelledQueuedTaskDoesNotRunAfterRestart(t *testing.T) {
	f := newRoutineFixture(t, config.Defaults(), domain.LaneAvailable, "")
	f.app.Paths.RunsDir = t.TempDir()
	f.app.Runner.RunDir = f.app.Paths.RunsDir
	ctx := context.Background()
	m := domain.Message{ID: "cancel-before-restart", ChannelID: f.general.ID, AuthorID: f.human.ID, Body: "@coder wait", CreatedAt: time.Now().UTC()}
	if _, err := f.s.Append(ctx, events.Draft{Type: events.MessagePosted, Actor: events.Human(f.human.ID), ChannelID: m.ChannelID, Payload: m}); err != nil {
		t.Fatal(err)
	}
	run, err := f.app.queueRun(ctx, m, f.coder, domain.RunRead, "", "", false)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.app.CancelRun(ctx, run.ID); err != nil {
		t.Fatal(err)
	}
	dispatched := make(chan struct{}, 1)
	f.app.queuedDispatch = func(context.Context, domain.Message, domain.Member, string) { dispatched <- struct{}{} }
	if err := f.app.recoverQueued(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case <-dispatched:
		t.Fatal("cancelled queue was dispatched")
	case <-time.After(30 * time.Millisecond):
	}
	got, err := f.s.Run(ctx, run.ID)
	if err != nil || got.State != domain.RunCancelled {
		t.Fatalf("cancelled run: %+v %v", got, err)
	}
}

// A worktree git cannot remove must not keep the daemon from starting, and
// the run must not be reported again on the next start.
func TestRecoveryCleanupFailureDoesNotStopStart(t *testing.T) {
	ctx := context.Background()
	f := newRoutineFixture(t, config.Defaults(), domain.LaneAvailable, "")
	root := t.TempDir()
	f.app.Paths.RunsDir = filepath.Join(root, "runs")
	f.app.Paths.WorktreesDir = filepath.Join(root, "trees")
	f.app.Runner.RunDir = f.app.Paths.RunsDir
	repo := filepath.Join(root, "repo")
	if err := os.Mkdir(repo, 0700); err != nil {
		t.Fatal(err)
	}
	testGit(t, repo, "init", "-b", "main")
	ch := f.general
	ch.RepoPath = repo
	if _, err := f.s.Append(ctx, events.Draft{Type: events.ChannelUpdated, Actor: events.System, ChannelID: ch.ID, Payload: ch}); err != nil {
		t.Fatal(err)
	}
	m := domain.Message{ID: "stray-message", ChannelID: ch.ID, AuthorID: f.human.ID, Body: "@coder change it", CreatedAt: time.Now().UTC()}
	if _, err := f.s.Append(ctx, events.Draft{Type: events.MessagePosted, Actor: events.Human(f.human.ID), ChannelID: ch.ID, Payload: m}); err != nil {
		t.Fatal(err)
	}
	// A plain directory: git refuses to remove it as a worktree.
	stray := filepath.Join(root, "stray")
	if err := os.Mkdir(stray, 0700); err != nil {
		t.Fatal(err)
	}
	ended := time.Now().UTC().Add(-time.Second)
	run := domain.Run{ID: "stray-worktree", ChannelID: ch.ID, TriggerMessageID: m.ID, AgentID: f.coder.ID, LaneID: "a", Mode: domain.RunWrite, State: domain.RunFailed, FailureClass: domain.FailureTransient, FailureReason: "outcome unknown after daemon restart", Worktree: stray, StartedAt: &ended, EndedAt: &ended}
	if _, err := f.s.Append(ctx, events.Draft{Type: events.RunCreated, Actor: events.System, ChannelID: ch.ID, Payload: run}); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(f.app.Paths.RunsDir, run.ID)
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	pending := func() {
		t.Helper()
		metadata, _ := json.Marshal(runner.Metadata{Run: run, PendingFinalization: true})
		if err := os.WriteFile(filepath.Join(dir, "run.json"), metadata, 0600); err != nil {
			t.Fatal(err)
		}
	}
	answers := func() int {
		t.Helper()
		messages, err := f.s.Messages(ctx, ch.ID, "", 50)
		if err != nil {
			t.Fatal(err)
		}
		n := 0
		for _, reply := range messages {
			if reply.RunID == run.ID {
				n++
			}
		}
		return n
	}
	pending()
	if _, err := f.app.Runner.Recover(ctx); err != nil {
		t.Fatalf("recover: %v", err)
	}
	if !noticeContaining(t, f.s, ch.ID, "was not fully recovered") {
		t.Fatal("cleanup failure was not reported")
	}
	if _, err := os.Stat(stray); err != nil {
		t.Fatalf("stray directory: %v", err)
	}
	if readMetadata(t, f.app, run.ID).PendingFinalization {
		t.Fatal("run still pending finalization")
	}
	if n := answers(); n != 1 {
		t.Fatalf("%d answers, want 1", n)
	}
	seq, err := f.s.LastSeq(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.app.Runner.Recover(ctx); err != nil {
		t.Fatalf("second recover: %v", err)
	}
	if again, _ := f.s.LastSeq(ctx); again != seq {
		t.Fatalf("second recover appended %d events", again-seq)
	}
	// Start sees the same state when the marker itself was lost.
	pending()
	startCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	if err := f.app.Start(startCtx); err != nil {
		t.Fatalf("start: %v", err)
	}
	if n := answers(); n != 1 {
		t.Fatalf("%d answers after start, want 1", n)
	}
}

func readMetadata(t *testing.T, a *App, id string) runner.Metadata {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(a.Paths.RunsDir, id, "run.json"))
	if err != nil {
		t.Fatal(err)
	}
	var m runner.Metadata
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

// laneBoundCLI fails with a login error on the "bad" model and answers on
// any other, so a persona with two lanes falls back to its second one.
type laneBoundCLI struct{}

func (laneBoundCLI) Name() string { return "codex" }
func (laneBoundCLI) Command(req adapters.Request) (adapters.Cmd, error) {
	script := "echo done on the good lane"
	if req.Model == "bad" {
		script = "echo 'Not logged in. Please log in.' >&2; exit 1"
	}
	return adapters.Cmd{Path: "/bin/sh", Args: []string{"-c", script}, Dir: req.Workdir}, nil
}
func (laneBoundCLI) Classify(code int, tail string) (domain.FailureClass, adapters.LaneSignal, string) {
	return (adapters.Codex{}).Classify(code, tail)
}

// newFallbackFixture has @coder on lane a, whose login is broken, and lane b.
func newFallbackFixture(t *testing.T) (*App, *store.Store, domain.Member, domain.Channel, domain.Message) {
	t.Helper()
	ctx := context.Background()
	root := t.TempDir()
	s, err := store.Open(filepath.Join(root, "db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	agent := domain.Member{ID: "coder", Kind: domain.MemberAgent, Handle: "coder", Agent: &domain.AgentInfo{Lanes: []string{"a", "b"}, Mode: domain.RunRead}}
	ch := domain.Channel{ID: "ch", Name: "work", Kind: domain.ChannelTeam, Visibility: domain.VisibilityPublic}
	m := domain.Message{ID: "m1", ChannelID: ch.ID, Body: "@coder review this", AuthorID: "human", CreatedAt: time.Now().UTC()}
	for _, d := range []events.Draft{
		{Type: events.MemberUpdated, Actor: events.System, Payload: agent},
		{Type: events.LaneUpdated, Actor: events.System, Payload: domain.Lane{ID: "a", CLI: "codex", Model: "bad", Capacity: 1, Health: domain.LaneAvailable, Windows: []domain.LaneWindow{}}},
		{Type: events.LaneUpdated, Actor: events.System, Payload: domain.Lane{ID: "b", CLI: "codex", Model: "good", Capacity: 1, Health: domain.LaneAvailable, Windows: []domain.LaneWindow{}}},
		{Type: events.ChannelCreated, Actor: events.System, ChannelID: ch.ID, Payload: ch},
		{Type: events.MessagePosted, Actor: events.Human("human"), ChannelID: ch.ID, Payload: m},
	} {
		if _, err := s.Append(ctx, d); err != nil {
			t.Fatal(err)
		}
	}
	a, err := New(ctx, s, config.Defaults(), config.Paths{DataDir: root, RunsDir: filepath.Join(root, "runs")})
	if err != nil {
		t.Fatal(err)
	}
	a.Adapters["codex"] = laneBoundCLI{}
	return a, s, agent, ch, m
}

// The run that lost its lane is answered by its retry; a restart must not
// report it a second time.
func TestLaneFallbackFinalizesTheFailedRun(t *testing.T) {
	ctx := context.Background()
	a, s, agent, ch, m := newFallbackFixture(t)
	if err := a.execute(ctx, m, agent, ""); err != nil {
		t.Fatalf("execute: %v", err)
	}
	runs, err := s.Runs(ctx, ch.ID, "")
	if err != nil || len(runs) != 2 {
		t.Fatalf("runs: %+v %v", runs, err)
	}
	var failed, retried domain.Run
	for _, run := range runs {
		if run.RetryOf == "" {
			failed = run
		} else {
			retried = run
		}
	}
	if failed.State != domain.RunFailed || failed.LaneID != "a" || retried.State != domain.RunDone || retried.LaneID != "b" || retried.RetryOf != failed.ID {
		t.Fatalf("fallback: %+v %+v", failed, retried)
	}
	if readMetadata(t, a, failed.ID).PendingFinalization {
		t.Fatal("failed run still pending finalization")
	}
	seq, err := s.LastSeq(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := a.Runner.Recover(ctx); err != nil {
		t.Fatal(err)
	}
	a.Runner.WaitRecovered()
	if again, _ := s.LastSeq(ctx); again != seq {
		t.Fatalf("restart appended %d events for a retried run", again-seq)
	}
}

// A queued run dispatched after a restart still moves to the next lane when
// its first lane fails.
func TestRecoveredQueueFallsBackToTheNextLane(t *testing.T) {
	ctx := context.Background()
	a, s, agent, ch, m := newFallbackFixture(t)
	queued, err := a.queueRun(ctx, m, agent, domain.RunRead, "", "", false)
	if err != nil {
		t.Fatal(err)
	}
	if err := a.recoverQueued(ctx); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		runs, err := s.Runs(ctx, ch.ID, "")
		if err != nil {
			t.Fatal(err)
		}
		for _, run := range runs {
			if run.RetryOf == queued.ID && run.State == domain.RunDone {
				if run.LaneID != "b" {
					t.Fatalf("retry ran on %s", run.LaneID)
				}
				if noticeContaining(t, s, ch.ID, "context canceled") {
					t.Fatal("retry was reported as cancelled")
				}
				return
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("no retry on lane b: %+v", runs)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// The request that posted the message may be gone before its mention is
// queued; the queue entry must still be written.
func TestOnMessageQueuesAfterTheRequestEnds(t *testing.T) {
	f := newRoutineFixture(t, config.Defaults(), domain.LaneAvailable, "")
	f.app.queuedDispatch = func(context.Context, domain.Message, domain.Member, string) {}
	m := domain.Message{ID: "hung-up", ChannelID: f.general.ID, AuthorID: f.human.ID, Body: "@coder do this", CreatedAt: time.Now().UTC()}
	if _, err := f.s.Append(context.Background(), events.Draft{Type: events.MessagePosted, Actor: events.Human(f.human.ID), ChannelID: m.ChannelID, Payload: m}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	f.app.OnMessage(ctx, m, []domain.Member{f.coder})
	runs, err := f.s.Runs(context.Background(), m.ChannelID, string(domain.RunQueued))
	if err != nil || len(runs) != 1 || runs[0].TriggerMessageID != m.ID {
		t.Fatalf("queued after the request ended: %+v %v", runs, err)
	}
}

// A run recorded as running whose run.json was never written has no process
// to reattach. Start must fail it; a run with run.json is left to the runner.
func TestRecoverOrphanedFailsRunsWithoutState(t *testing.T) {
	ctx := context.Background()
	a, s, agent, ch, m := newFallbackFixture(t)
	start := func() domain.Run {
		run, err := a.queueRun(ctx, m, agent, domain.RunRead, "", store.NewID(), false)
		if err != nil {
			t.Fatal(err)
		}
		now := time.Now().UTC()
		run.State, run.StartedAt = domain.RunRunning, &now
		if _, err := s.Append(ctx, events.Draft{Type: events.RunUpdated, Actor: events.System, ChannelID: ch.ID, Payload: run}); err != nil {
			t.Fatal(err)
		}
		return run
	}
	orphan, tracked := start(), start()
	if err := os.MkdirAll(filepath.Join(a.Paths.RunsDir, tracked.ID), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(a.Paths.RunsDir, tracked.ID, "run.json"), []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := a.recoverOrphaned(ctx); err != nil {
		t.Fatal(err)
	}
	got, err := s.Run(ctx, orphan.ID)
	if err != nil || got.State != domain.RunFailed || got.EndedAt == nil {
		t.Fatalf("orphan: %+v %v", got, err)
	}
	if got, err = s.Run(ctx, tracked.ID); err != nil || got.State != domain.RunRunning {
		t.Fatalf("tracked: %+v %v", got, err)
	}
}

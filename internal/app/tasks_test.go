package app

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/config"
	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/store"
	"github.com/thiagodefreitas/faztudo/internal/tasks"
)

type taskFixture struct {
	*routineFixture
	mu        sync.Mutex
	dispatch  []dispatched
	runState  domain.RunState
	holdUntil chan struct{}
}

type dispatched struct {
	msg      domain.Message
	override string
}

func newTaskFixture(t *testing.T) *taskFixture {
	t.Helper()
	f := &taskFixture{routineFixture: newRoutineFixture(t, config.Config{}, domain.LaneAvailable, ""), runState: domain.RunDone}
	f.app.taskDispatch = f.fakeRun
	return f
}

// fakeRun stands in for a.run: it leaves one run behind for the message.
func (f *taskFixture) fakeRun(ctx context.Context, m domain.Message, agent domain.Member, override string) {
	f.mu.Lock()
	f.dispatch = append(f.dispatch, dispatched{m, override})
	wait, state := f.holdUntil, f.runState
	f.mu.Unlock()
	if wait != nil {
		<-wait
	}
	run := domain.Run{ID: store.NewID(), ChannelID: m.ChannelID, TriggerMessageID: m.ID, AgentID: agent.ID, LaneID: "a", Mode: domain.RunRead, State: state}
	_, _ = f.s.Append(ctx, events.Draft{Type: events.RunCreated, Actor: events.System, ChannelID: m.ChannelID, Payload: run})
}

func (f *taskFixture) create(t *testing.T, in tasks.Input) domain.Task {
	t.Helper()
	task, err := f.app.CreateTask(context.Background(), f.human, f.general.ID, in)
	if err != nil {
		t.Fatal(err)
	}
	return task
}

func (f *taskFixture) waitStatus(t *testing.T, id string, want domain.TaskStatus) domain.Task {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		task, err := f.s.Task(context.Background(), id)
		if err == nil && task.Status == want {
			return task
		}
		if time.Now().After(deadline) {
			t.Fatalf("task %s is %q (%v), want %q", id, task.Status, err, want)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestCreateTaskChecksAssigneeAndChannel(t *testing.T) {
	f := newTaskFixture(t)
	ctx := context.Background()
	var user domain.UserError
	if _, err := f.app.CreateTask(ctx, f.human, f.general.ID, tasks.Input{Title: "x", Assignee: "nobody"}); !errors.As(err, &user) {
		t.Fatalf("unknown assignee: want a user error, got %v", err)
	}
	if _, err := f.app.CreateTask(ctx, f.human, "missing", tasks.Input{Title: "x", Assignee: "coder"}); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("unknown channel: want not found, got %v", err)
	}
	first := f.create(t, tasks.Input{Title: "First", Assignee: "@coder"})
	second := f.create(t, tasks.Input{Title: "Second", Assignee: "coder"})
	if first.Status != domain.TaskTodo || first.Assignee != "coder" || second.Order <= first.Order {
		t.Fatalf("new tasks queue at the end of Todo: %+v %+v", first, second)
	}
}

func TestStartTaskPostsDirectiveAndReportsBack(t *testing.T) {
	f := newTaskFixture(t)
	ctx := context.Background()
	task := f.create(t, tasks.Input{Title: "Fix login", Body: "It drops the password.", Assignee: "coder", Lane: "a", Checks: []string{"npm test"}, Acceptance: []string{"Login works"}})
	started, err := f.app.StartTask(ctx, f.human, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if started.MessageID == "" {
		t.Fatalf("start must link the message: %+v", started)
	}
	done := f.waitStatus(t, task.ID, domain.TaskDone)
	if len(done.RunIDs) != 1 {
		t.Fatalf("the run reports back: %+v", done)
	}
	msg, err := f.s.Message(ctx, started.MessageID)
	if err != nil {
		t.Fatal(err)
	}
	if msg.Task != task.ID || msg.AuthorID != f.human.ID || len(msg.Mentions) != 1 || msg.Mentions[0] != f.coder.ID {
		t.Fatalf("message: %+v", msg)
	}
	for _, want := range []string{"@coder Task: Fix login", "It drops the password.", "Checks (run them and report the result):\n- npm test", "Acceptance criteria:\n- Login works"} {
		if !strings.Contains(msg.Body, want) {
			t.Errorf("message body lacks %q:\n%s", want, msg.Body)
		}
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.dispatch) != 1 || f.dispatch[0].override != "a" || f.dispatch[0].msg.ID != msg.ID {
		t.Fatalf("dispatch: %+v", f.dispatch)
	}
}

func TestStartTaskRefusesWhatCannotRun(t *testing.T) {
	f := newTaskFixture(t)
	ctx := context.Background()
	var user domain.UserError
	badLane := f.create(t, tasks.Input{Title: "Lane", Assignee: "coder", Lane: "elsewhere"})
	if _, err := f.app.StartTask(ctx, f.human, badLane.ID); !errors.As(err, &user) {
		t.Fatalf("unknown lane: want a user error, got %v", err)
	}
	write := f.create(t, tasks.Input{Title: "Write", Assignee: "coder", Mode: domain.RunWrite})
	if _, err := f.app.StartTask(ctx, f.human, write.ID); !errors.As(err, &user) || !strings.Contains(err.Error(), "repo_path") {
		t.Fatalf("write without a repo: want a repo_path error, got %v", err)
	}
	for _, id := range []string{badLane.ID, write.ID} {
		if got, _ := f.s.Task(ctx, id); got.Status != domain.TaskTodo || got.MessageID != "" {
			t.Errorf("a refused start leaves the task in Todo: %+v", got)
		}
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.dispatch) != 0 {
		t.Fatalf("nothing may run: %+v", f.dispatch)
	}
}

func TestStartTaskRefusesArchivedProject(t *testing.T) {
	f := newTaskFixture(t)
	ctx := context.Background()
	task := f.create(t, tasks.Input{Title: "Do work", Assignee: "coder"})
	project := domain.Project{Handle: "old", Name: "Old", Channels: []string{f.general.Name}, Archived: true}
	if _, err := f.s.Append(ctx, events.Draft{Type: events.ProjectUpdated, Actor: events.Human(f.human.ID), Payload: project}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.app.StartTask(ctx, f.human, task.ID); err == nil || !strings.Contains(err.Error(), "archived") {
		t.Fatalf("archived task: %v", err)
	}
	got, err := f.s.Task(ctx, task.ID)
	if err != nil || got.Status != domain.TaskTodo || got.MessageID != "" {
		t.Fatalf("task changed: %+v, %v", got, err)
	}
}

func TestStartTaskTwiceIsRefused(t *testing.T) {
	f := newTaskFixture(t)
	f.holdUntil = make(chan struct{})
	task := f.create(t, tasks.Input{Title: "Once", Assignee: "coder"})
	if _, err := f.app.StartTask(context.Background(), f.human, task.ID); err != nil {
		t.Fatal(err)
	}
	var user domain.UserError
	if _, err := f.app.StartTask(context.Background(), f.human, task.ID); !errors.As(err, &user) {
		t.Fatalf("second start: want a user error, got %v", err)
	}
	close(f.holdUntil)
	f.waitStatus(t, task.ID, domain.TaskDone)
}

func TestTaskWithoutARunFails(t *testing.T) {
	f := newTaskFixture(t)
	f.app.taskDispatch = func(context.Context, domain.Message, domain.Member, string) {}
	task := f.create(t, tasks.Input{Title: "Nothing", Assignee: "coder"})
	if _, err := f.app.StartTask(context.Background(), f.human, task.ID); err != nil {
		t.Fatal(err)
	}
	f.waitStatus(t, task.ID, domain.TaskFailed)
}

func TestApprovalMovesTaskToReviewThenDone(t *testing.T) {
	f := newTaskFixture(t)
	ctx := context.Background()
	f.runState = domain.RunWaitingApproval
	task := f.create(t, tasks.Input{Title: "Change", Assignee: "coder"})
	started, _ := f.app.StartTask(ctx, f.human, task.ID)
	review := f.waitStatus(t, task.ID, domain.TaskReview)
	approval := domain.Approval{ID: store.NewID(), RunID: review.RunIDs[0], ChannelID: f.general.ID, RequestedBy: f.coder.ID, Title: "Merge", State: domain.ApprovalPending}
	if _, err := f.s.Append(ctx, events.Draft{Type: events.ApprovalRequested, Actor: events.System, ChannelID: f.general.ID, Payload: approval}); err != nil {
		t.Fatal(err)
	}
	f.app.syncTask(ctx, started.MessageID, true)
	if got, _ := f.s.Task(ctx, task.ID); got.ApprovalID != approval.ID || got.Status != domain.TaskReview {
		t.Fatalf("approval is linked and the task waits: %+v", got)
	}
	run, _ := f.s.Run(ctx, review.RunIDs[0])
	run.State = domain.RunDone
	approval.State = domain.ApprovalResolved
	for _, d := range []events.Draft{
		{Type: events.RunUpdated, Actor: events.System, ChannelID: f.general.ID, Payload: run},
		{Type: events.ApprovalResolved, Actor: events.Human(f.human.ID), ChannelID: f.general.ID, Payload: approval},
	} {
		if _, err := f.s.Append(ctx, d); err != nil {
			t.Fatal(err)
		}
	}
	f.app.syncTask(ctx, started.MessageID, true)
	if got, _ := f.s.Task(ctx, task.ID); got.Status != domain.TaskDone {
		t.Fatalf("a resolved approval resolves the task: %+v", got)
	}
}

func TestUpdateAndCancelTask(t *testing.T) {
	f := newTaskFixture(t)
	ctx := context.Background()
	title := "Renamed"
	task := f.create(t, tasks.Input{Title: "Old", Assignee: "coder"})
	updated, err := f.app.UpdateTask(ctx, f.human, task.ID, tasks.Patch{Title: &title})
	if err != nil || updated.Title != "Renamed" {
		t.Fatalf("update: %+v %v", updated, err)
	}
	other := "nobody"
	var user domain.UserError
	if _, err := f.app.UpdateTask(ctx, f.human, task.ID, tasks.Patch{Assignee: &other}); !errors.As(err, &user) {
		t.Fatalf("unknown assignee on update: want a user error, got %v", err)
	}
	cancelled, err := f.app.CancelTask(ctx, f.human, task.ID)
	if err != nil || cancelled.Status != domain.TaskCancelled {
		t.Fatalf("cancel: %+v %v", cancelled, err)
	}
	if _, err := f.app.UpdateTask(ctx, f.human, task.ID, tasks.Patch{Title: &title}); !errors.As(err, &user) {
		t.Fatalf("a cancelled task is not editable, got %v", err)
	}
	if _, err := f.app.CancelTask(ctx, f.human, task.ID); !errors.As(err, &user) {
		t.Fatalf("cancel twice: want a user error, got %v", err)
	}
}

func TestCancelRunningTaskStopsItsRuns(t *testing.T) {
	f := newTaskFixture(t)
	ctx := context.Background()
	f.holdUntil = make(chan struct{})
	task := f.create(t, tasks.Input{Title: "Long", Assignee: "coder"})
	if _, err := f.app.StartTask(ctx, f.human, task.ID); err != nil {
		t.Fatal(err)
	}
	got, err := f.app.CancelTask(ctx, f.human, task.ID)
	if err != nil || got.Status != domain.TaskCancelled {
		t.Fatalf("cancel running: %+v %v", got, err)
	}
	close(f.holdUntil)
	time.Sleep(50 * time.Millisecond)
	if after, _ := f.s.Task(ctx, task.ID); after.Status != domain.TaskCancelled {
		t.Fatalf("a late run must not revive a cancelled task: %+v", after)
	}
}

func TestListTasksFiltersByProject(t *testing.T) {
	f := newTaskFixture(t)
	f.create(t, tasks.Input{Title: "One", Assignee: "coder"})
	list, err := f.app.ListTasks(context.Background(), f.general.ID)
	if err != nil || len(list) != 1 {
		t.Fatalf("list: %+v %v", list, err)
	}
}

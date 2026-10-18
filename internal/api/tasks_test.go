package api

import (
	"context"
	"testing"

	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/store"
	"github.com/thiagodefreitas/faztudo/internal/tasks"
)

// fakeTasks keeps tasks in memory and records what the API asked for.
type fakeTasks struct {
	list    []domain.Task
	created tasks.Input
	channel string
	patch   tasks.Patch
	started []string
	err     error
}

func (f *fakeTasks) ListTasks(_ context.Context, channelID string) ([]domain.Task, error) {
	out := []domain.Task{}
	for _, t := range f.list {
		if channelID == "" || t.ChannelID == channelID {
			out = append(out, t)
		}
	}
	return out, nil
}
func (f *fakeTasks) GetTask(_ context.Context, id string) (domain.Task, error) {
	for _, t := range f.list {
		if t.ID == id {
			return t, nil
		}
	}
	return domain.Task{}, store.ErrNotFound
}
func (f *fakeTasks) CreateTask(_ context.Context, _ domain.Member, channelID string, in tasks.Input) (domain.Task, error) {
	f.created, f.channel = in, channelID
	if f.err != nil {
		return domain.Task{}, f.err
	}
	t := domain.Task{ID: "t-new", ChannelID: channelID, Title: in.Title, Assignee: in.Assignee, Status: domain.TaskTodo}
	f.list = append(f.list, t)
	return t, nil
}
func (f *fakeTasks) UpdateTask(_ context.Context, _ domain.Member, id string, p tasks.Patch) (domain.Task, error) {
	f.patch = p
	t, err := f.GetTask(context.Background(), id)
	if err == nil && p.Title != nil {
		t.Title = *p.Title
	}
	return t, err
}
func (f *fakeTasks) StartTask(_ context.Context, _ domain.Member, id string) (domain.Task, error) {
	f.started = append(f.started, id)
	if f.err != nil {
		return domain.Task{}, f.err
	}
	t, err := f.GetTask(context.Background(), id)
	t.Status = domain.TaskRunning
	return t, err
}
func (f *fakeTasks) CancelTask(_ context.Context, _ domain.Member, id string) (domain.Task, error) {
	t, err := f.GetTask(context.Background(), id)
	t.Status = domain.TaskCancelled
	return t, err
}

func TestTasksEndpoints(t *testing.T) {
	f := newOrgFixture(t)
	fake := &fakeTasks{list: []domain.Task{
		{ID: "t1", ChannelID: f.proj.ID, Title: "In project", Status: domain.TaskTodo},
		{ID: "t2", ChannelID: f.team.ID, Title: "Elsewhere", Status: domain.TaskTodo},
	}}
	f.h.Tasks = fake

	var all, byChannel, byProject []domain.Task
	f.do(t, "GET", "/api/v1/tasks", "", 200, &all)
	f.do(t, "GET", "/api/v1/tasks?channel_id="+f.team.ID, "", 200, &byChannel)
	f.do(t, "GET", "/api/v1/tasks?project=faztudo", "", 200, &byProject)
	if len(all) != 2 || len(byChannel) != 1 || byChannel[0].ID != "t2" || len(byProject) != 1 || byProject[0].ID != "t1" {
		t.Fatalf("all %d, channel %+v, project %+v", len(all), byChannel, byProject)
	}
	f.do(t, "GET", "/api/v1/tasks?project=nope", "", 404, nil)

	var created domain.Task
	f.do(t, "POST", "/api/v1/tasks", `{"channel_id":"`+f.team.ID+`","title":"Fix","assignee":"coder","mode":"write","checks":["go test"]}`, 201, &created)
	if created.ID != "t-new" || fake.channel != f.team.ID || fake.created.Mode != domain.RunWrite || len(fake.created.Checks) != 1 || len(fake.started) != 0 {
		t.Fatalf("create: %+v %+v", created, fake)
	}
	f.do(t, "POST", "/api/v1/tasks", `{"channel_id":"`+f.team.ID+`","title":"Go","assignee":"coder","start":true}`, 201, &created)
	if len(fake.started) != 1 || created.Status != domain.TaskRunning {
		t.Fatalf("create with start: %+v started=%v", created, fake.started)
	}
	f.do(t, "POST", "/api/v1/tasks", `{"title":"No channel","assignee":"coder"}`, 400, nil)
	f.do(t, "POST", "/api/v1/tasks", `{"channel_id":"x","surprise":1}`, 400, nil)

	var patched domain.Task
	f.do(t, "PATCH", "/api/v1/tasks/t1", `{"title":"Renamed","order":1.5}`, 200, &patched)
	if patched.Title != "Renamed" || fake.patch.Order == nil || *fake.patch.Order != 1.5 {
		t.Fatalf("patch: %+v %+v", patched, fake.patch)
	}
	var started, cancelled, one domain.Task
	f.do(t, "POST", "/api/v1/tasks/t1/start", "", 200, &started)
	f.do(t, "POST", "/api/v1/tasks/t1/cancel", "", 200, &cancelled)
	f.do(t, "GET", "/api/v1/tasks/t1", "", 200, &one)
	if started.Status != domain.TaskRunning || cancelled.Status != domain.TaskCancelled || one.ID != "t1" {
		t.Fatalf("start %+v cancel %+v get %+v", started, cancelled, one)
	}
	f.do(t, "GET", "/api/v1/tasks/missing", "", 404, nil)
}

func TestTaskUserErrorsAreShown(t *testing.T) {
	f := newOrgFixture(t)
	f.h.Tasks = &fakeTasks{list: []domain.Task{{ID: "t1", ChannelID: f.team.ID}}, err: domain.UserError{Message: "There is no agent @ghost."}}
	var body struct {
		Error struct{ Message string }
	}
	f.do(t, "POST", "/api/v1/tasks", `{"channel_id":"`+f.team.ID+`","title":"x","assignee":"ghost"}`, 400, &body)
	if body.Error.Message != "There is no agent @ghost." {
		t.Fatalf("message: %q", body.Error.Message)
	}
	f.do(t, "POST", "/api/v1/tasks/t1/start", "", 409, &body)
}

func TestApprovalHookRunsAfterDecision(t *testing.T) {
	f := newOrgFixture(t)
	var seen []string
	f.h.OnApproval = func(_ context.Context, a domain.Approval) { seen = append(seen, a.ID) }
	approval := domain.Approval{ID: "ap1", ChannelID: f.team.ID, RequestedBy: f.coder.ID, Title: "Go?", State: domain.ApprovalPending,
		Options: []domain.ApprovalOption{{Key: "yes", Label: "Yes"}}}
	if _, err := f.h.Store.Append(context.Background(), events.Draft{Type: events.ApprovalRequested, Actor: events.Agent(f.coder.ID), ChannelID: f.team.ID, Payload: approval}); err != nil {
		t.Fatal(err)
	}
	f.do(t, "POST", "/api/v1/approvals/ap1/resolve", `{"option":"yes"}`, 200, nil)
	if len(seen) != 1 || seen[0] != "ap1" {
		t.Fatalf("hook calls: %v", seen)
	}
}

package api

import (
	"context"
	"errors"
	"net/http"
	"slices"

	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/store"
	"github.com/thiagodefreitas/faztudo/internal/tasks"
)

// TaskControl lists, changes and starts task directives. The app implements
// it. Errors that are domain.UserError are shown to the person as written.
type TaskControl interface {
	ListTasks(ctx context.Context, channelID string) ([]domain.Task, error)
	GetTask(ctx context.Context, id string) (domain.Task, error)
	CreateTask(ctx context.Context, by domain.Member, channelID string, in tasks.Input) (domain.Task, error)
	UpdateTask(ctx context.Context, by domain.Member, id string, p tasks.Patch) (domain.Task, error)
	StartTask(ctx context.Context, by domain.Member, id string) (domain.Task, error)
	CancelTask(ctx context.Context, by domain.Member, id string) (domain.Task, error)
}

type noTasks struct{}

func (noTasks) ListTasks(context.Context, string) ([]domain.Task, error) { return []domain.Task{}, nil }
func (noTasks) GetTask(context.Context, string) (domain.Task, error) {
	return domain.Task{}, store.ErrNotFound
}
func (noTasks) CreateTask(context.Context, domain.Member, string, tasks.Input) (domain.Task, error) {
	return domain.Task{}, store.ErrNotFound
}
func (noTasks) UpdateTask(context.Context, domain.Member, string, tasks.Patch) (domain.Task, error) {
	return domain.Task{}, store.ErrNotFound
}
func (noTasks) StartTask(context.Context, domain.Member, string) (domain.Task, error) {
	return domain.Task{}, store.ErrNotFound
}
func (noTasks) CancelTask(context.Context, domain.Member, string) (domain.Task, error) {
	return domain.Task{}, store.ErrNotFound
}

// taskFail shows a UserError as written, with the status the caller chose
// for it, and anything else as a normal failure.
func taskFail(w http.ResponseWriter, err error, status int, code string) {
	var user domain.UserError
	if errors.As(err, &user) {
		fail(w, status, code, user.Message)
		return
	}
	failErr(w, err)
}

func (a *API) listTasks(w http.ResponseWriter, r *http.Request) {
	list, err := a.Tasks.ListTasks(r.Context(), r.URL.Query().Get("channel_id"))
	if err != nil {
		failErr(w, err)
		return
	}
	if handle := r.URL.Query().Get("project"); handle != "" {
		list, err = a.tasksOfProject(r.Context(), handle, list)
		if err != nil {
			failErr(w, err)
			return
		}
	}
	respond(w, 200, list)
}

// tasksOfProject keeps the tasks in the project's channels.
func (a *API) tasksOfProject(ctx context.Context, handle string, list []domain.Task) ([]domain.Task, error) {
	projects, err := a.Store.Projects(ctx)
	if err != nil {
		return nil, err
	}
	i := slices.IndexFunc(projects, func(p domain.Project) bool { return p.Handle == handle })
	if i < 0 {
		return nil, store.ErrNotFound
	}
	channels, err := a.Store.Channels(ctx)
	if err != nil {
		return nil, err
	}
	ids := map[string]bool{}
	for _, c := range channels {
		if slices.Contains(projects[i].Channels, c.Name) {
			ids[c.ID] = true
		}
	}
	out := []domain.Task{}
	for _, t := range list {
		if ids[t.ChannelID] {
			out = append(out, t)
		}
	}
	return out, nil
}

func (a *API) getTask(w http.ResponseWriter, r *http.Request) {
	t, err := a.Tasks.GetTask(r.Context(), r.PathValue("id"))
	if err != nil {
		failErr(w, err)
		return
	}
	respond(w, 200, t)
}

func (a *API) createTask(w http.ResponseWriter, r *http.Request) {
	if current(r).Kind != domain.MemberHuman {
		fail(w, 403, "forbidden", "only a human can create a task")
		return
	}
	var v struct {
		tasks.Input
		ChannelID string `json:"channel_id"`
		Start     bool   `json:"start"`
	}
	if !decode(w, r, &v) {
		return
	}
	if v.ChannelID == "" {
		fail(w, 400, "bad_request", "channel_id required")
		return
	}
	t, err := a.Tasks.CreateTask(r.Context(), current(r), v.ChannelID, v.Input)
	if err != nil {
		taskFail(w, err, 400, "bad_request")
		return
	}
	if v.Start {
		if t, err = a.Tasks.StartTask(r.Context(), current(r), t.ID); err != nil {
			taskFail(w, err, 409, "conflict")
			return
		}
	}
	respond(w, 201, t)
}

func (a *API) patchTask(w http.ResponseWriter, r *http.Request) {
	if current(r).Kind != domain.MemberHuman {
		fail(w, 403, "forbidden", "only a human can change a task")
		return
	}
	var p tasks.Patch
	if !decode(w, r, &p) {
		return
	}
	t, err := a.Tasks.UpdateTask(r.Context(), current(r), r.PathValue("id"), p)
	if err != nil {
		taskFail(w, err, 400, "bad_request")
		return
	}
	respond(w, 200, t)
}

func (a *API) taskAction(start bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if current(r).Kind != domain.MemberHuman {
			fail(w, 403, "forbidden", "only a human can start or cancel a task")
			return
		}
		var t domain.Task
		var err error
		if start {
			t, err = a.Tasks.StartTask(r.Context(), current(r), r.PathValue("id"))
		} else {
			t, err = a.Tasks.CancelTask(r.Context(), current(r), r.PathValue("id"))
		}
		if err != nil {
			taskFail(w, err, 409, "conflict")
			return
		}
		respond(w, 200, t)
	}
}

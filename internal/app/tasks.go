package app

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/org"
	"github.com/thiagodefreitas/faztudo/internal/store"
	"github.com/thiagodefreitas/faztudo/internal/tasks"
)

// agentByHandle finds the agent a task is for.
func (a *App) agentByHandle(ctx context.Context, handle string) (domain.Member, error) {
	members, err := a.Store.Members(ctx)
	if err != nil {
		return domain.Member{}, err
	}
	for _, m := range members {
		if m.Kind == domain.MemberAgent && m.Agent != nil && strings.EqualFold(m.Handle, handle) {
			return m, nil
		}
	}
	return domain.Member{}, domain.UserError{Message: "There is no agent @" + handle + "."}
}

// ListTasks lists the tasks of a channel, or of every channel when channelID
// is empty.
func (a *App) ListTasks(ctx context.Context, channelID string) ([]domain.Task, error) {
	return a.Store.Tasks(ctx, channelID)
}

func (a *App) GetTask(ctx context.Context, id string) (domain.Task, error) {
	return a.Store.Task(ctx, id)
}

// CreateTask adds a task to the end of a channel's Todo column. Nothing runs.
func (a *App) CreateTask(ctx context.Context, by domain.Member, channelID string, in tasks.Input) (domain.Task, error) {
	in, err := tasks.Normalize(in)
	if err != nil {
		return domain.Task{}, domain.UserError{Message: err.Error()}
	}
	if _, err := a.Store.Channel(ctx, channelID); err != nil {
		return domain.Task{}, err
	}
	if _, err := a.agentByHandle(ctx, in.Assignee); err != nil {
		return domain.Task{}, err
	}
	a.taskMu.Lock()
	defer a.taskMu.Unlock()
	existing, err := a.Store.Tasks(ctx, channelID)
	if err != nil {
		return domain.Task{}, err
	}
	order := 1.0
	for _, t := range existing {
		if t.Order >= order {
			order = t.Order + 1
		}
	}
	now := time.Now().UTC()
	t := domain.Task{ID: store.NewID(), ChannelID: channelID, Title: in.Title, Body: in.Body, Assignee: in.Assignee, Lane: in.Lane, Mode: in.Mode,
		Scope: in.Scope, Checks: in.Checks, Acceptance: in.Acceptance, Status: domain.TaskTodo, Order: order, RunIDs: []string{}, CreatedBy: by.ID, CreatedAt: now, UpdatedAt: now}
	if _, err := a.Store.Append(ctx, events.Draft{Type: events.TaskCreated, Actor: events.Human(by.ID), ChannelID: channelID, Payload: t}); err != nil {
		return domain.Task{}, err
	}
	return t, nil
}

// UpdateTask changes a task that is still in Todo.
func (a *App) UpdateTask(ctx context.Context, by domain.Member, id string, p tasks.Patch) (domain.Task, error) {
	a.taskMu.Lock()
	defer a.taskMu.Unlock()
	t, err := a.Store.Task(ctx, id)
	if err != nil {
		return domain.Task{}, err
	}
	next, err := tasks.Apply(t, p)
	if err != nil {
		return domain.Task{}, domain.UserError{Message: err.Error()}
	}
	if next.Assignee != t.Assignee {
		if _, err := a.agentByHandle(ctx, next.Assignee); err != nil {
			return domain.Task{}, err
		}
	}
	next.UpdatedAt = time.Now().UTC()
	if _, err := a.Store.Append(ctx, events.Draft{Type: events.TaskUpdated, Actor: events.Human(by.ID), ChannelID: t.ChannelID, Payload: next}); err != nil {
		return domain.Task{}, err
	}
	return next, nil
}

// StartTask posts the task's directive as a message that mentions the
// assignee, which starts the run. A task that cannot run is refused before
// anything is posted.
func (a *App) StartTask(ctx context.Context, by domain.Member, id string) (domain.Task, error) {
	a.taskMu.Lock()
	defer a.taskMu.Unlock()
	t, err := a.Store.Task(ctx, id)
	if err != nil {
		return domain.Task{}, err
	}
	if t.Status != domain.TaskTodo && t.Status != domain.TaskFailed && t.Status != domain.TaskCancelled {
		return domain.Task{}, domain.UserError{Message: "This task is already " + string(t.Status) + "."}
	}
	channel, err := a.Store.Channel(ctx, t.ChannelID)
	if err != nil {
		return domain.Task{}, err
	}
	projects, err := a.Store.Projects(ctx)
	if err != nil {
		return domain.Task{}, err
	}
	if project, ok := org.ProjectOfChannel(projects, channel.Name); ok && project.Archived {
		return domain.Task{}, domain.UserError{Message: "Project " + project.Name + " is archived, so this task did not run."}
	}
	agent, err := a.agentByHandle(ctx, t.Assignee)
	if err != nil {
		return domain.Task{}, err
	}
	departments, err := a.Store.Departments(ctx)
	if err != nil {
		return domain.Task{}, err
	}
	if allowed, _ := org.Gate(projects, departments, channel.Name, []domain.Member{agent}); len(allowed) == 0 {
		return domain.Task{}, domain.UserError{Message: "@" + agent.Handle + " is not assigned to this project's team."}
	}
	if t.Mode == domain.RunWrite && channel.RepoPath == "" {
		return domain.Task{}, domain.UserError{Message: "Write tasks need a channel repo_path. Set it with PATCH /api/v1/channels/" + channel.ID + "."}
	}
	if t.Lane != "" {
		if err := a.syncManualLane(ctx, t.Lane); err != nil {
			return domain.Task{}, err
		}
		if err := a.checkLaneOverride(agent, t.Lane); err != nil {
			return domain.Task{}, domain.UserError{Message: err.Error()}
		}
	}
	msg := domain.Message{ID: store.NewID(), ChannelID: channel.ID, AuthorID: by.ID, Body: tasks.Render(t), Mentions: []string{agent.ID}, Task: t.ID, CreatedAt: time.Now().UTC()}
	if _, err := a.Store.Append(ctx, events.Draft{Type: events.MessagePosted, Actor: events.Human(by.ID), ChannelID: channel.ID, Payload: msg}); err != nil {
		return domain.Task{}, err
	}
	if _, err := a.queueRun(ctx, msg, agent, t.Mode, t.Lane, "", false); err != nil {
		return domain.Task{}, err
	}
	t.MessageID, t.Status, t.RunIDs, t.ApprovalID, t.UpdatedAt = msg.ID, domain.TaskRunning, []string{}, "", time.Now().UTC()
	if _, err := a.Store.Append(ctx, events.Draft{Type: events.TaskUpdated, Actor: events.Human(by.ID), ChannelID: channel.ID, Payload: t}); err != nil {
		return domain.Task{}, err
	}
	lane := t.Lane
	go func() {
		bg := context.Background()
		if a.taskDispatch != nil {
			a.taskDispatch(bg, msg, agent, lane)
		} else {
			a.run(bg, msg, agent, lane)
		}
		a.syncTask(bg, msg.ID, true)
	}()
	return t, nil
}

// CancelTask drops a Todo task or stops a running one and its runs. A task
// that waits for an approval is resolved through the approval instead.
func (a *App) CancelTask(ctx context.Context, by domain.Member, id string) (domain.Task, error) {
	a.taskMu.Lock()
	defer a.taskMu.Unlock()
	t, err := a.Store.Task(ctx, id)
	if err != nil {
		return domain.Task{}, err
	}
	switch t.Status {
	case domain.TaskTodo, domain.TaskRunning:
	case domain.TaskReview:
		return domain.Task{}, domain.UserError{Message: "This task waits for your decision. Merge, keep or discard its approval instead."}
	default:
		return domain.Task{}, domain.UserError{Message: "This task is already " + string(t.Status) + "."}
	}
	if t.Status == domain.TaskRunning {
		runs, err := a.Store.Runs(ctx, t.ChannelID, "")
		if err != nil {
			return domain.Task{}, err
		}
		for _, r := range runs {
			if r.TriggerMessageID == t.MessageID && !r.State.Terminal() {
				_ = a.CancelRun(ctx, r.ID)
			}
		}
	}
	t.Status, t.UpdatedAt = domain.TaskCancelled, time.Now().UTC()
	if _, err := a.Store.Append(ctx, events.Draft{Type: events.TaskUpdated, Actor: events.Human(by.ID), ChannelID: t.ChannelID, Payload: t}); err != nil {
		return domain.Task{}, err
	}
	return t, nil
}

// syncTask brings the task that messageID started up to date with its runs
// and approval. finished says the run code for the message has returned. A
// message that started no task is ignored.
func (a *App) syncTask(ctx context.Context, messageID string, finished bool) {
	if messageID == "" {
		return
	}
	a.taskMu.Lock()
	defer a.taskMu.Unlock()
	t, err := a.Store.TaskByMessage(ctx, messageID)
	if err != nil {
		return
	}
	runs, err := a.Store.Runs(ctx, t.ChannelID, "")
	if err != nil {
		return
	}
	approvals, err := a.Store.Approvals(ctx, "")
	if err != nil {
		return
	}
	next, changed := tasks.Derive(t, runs, approvals, finished)
	if !changed {
		return
	}
	next.UpdatedAt = time.Now().UTC()
	if _, err := a.Store.Append(ctx, events.Draft{Type: events.TaskUpdated, Actor: events.System, ChannelID: t.ChannelID, Payload: next}); err != nil && !errors.Is(err, context.Canceled) {
		a.notice(ctx, t.ChannelID, "warn", "Could not update task "+t.Title+": "+err.Error())
	}
}

// TaskForApproval is the hook the API calls after an approval is decided.
func (a *App) TaskForApproval(ctx context.Context, approval domain.Approval) {
	if approval.RunID == "" {
		return
	}
	if run, err := a.Store.Run(ctx, approval.RunID); err == nil {
		a.syncTask(ctx, run.TriggerMessageID, true)
	}
}

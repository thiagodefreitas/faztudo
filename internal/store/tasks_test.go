package store

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
)

func TestTasksAreProjectedFromEvents(t *testing.T) {
	ctx := context.Background()
	s := searchStore(t)
	task := domain.Task{ID: "t1", ChannelID: "c1", Title: "Fix", Assignee: "coder", Mode: domain.RunRead, Status: domain.TaskTodo, Order: 2,
		Scope: []string{}, Checks: []string{}, Acceptance: []string{}, RunIDs: []string{}, CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC()}
	other := task
	other.ID, other.ChannelID, other.Order = "t2", "c2", 1
	for _, tk := range []domain.Task{task, other} {
		if _, err := s.Append(ctx, events.Draft{Type: events.TaskCreated, Actor: events.Human("h"), ChannelID: tk.ChannelID, Payload: tk}); err != nil {
			t.Fatal(err)
		}
	}
	task.Status, task.MessageID = domain.TaskRunning, "m1"
	if _, err := s.Append(ctx, events.Draft{Type: events.TaskUpdated, Actor: events.System, ChannelID: "c1", Payload: task}); err != nil {
		t.Fatal(err)
	}
	all, err := s.Tasks(ctx, "")
	if err != nil || len(all) != 2 || all[0].ID != "t2" {
		t.Fatalf("all tasks (by order): %+v %v", all, err)
	}
	one, err := s.Tasks(ctx, "c1")
	if err != nil || len(one) != 1 || one[0].Status != domain.TaskRunning {
		t.Fatalf("channel tasks: %+v %v", one, err)
	}
	byMessage, err := s.TaskByMessage(ctx, "m1")
	if err != nil || byMessage.ID != "t1" {
		t.Fatalf("by message: %+v %v", byMessage, err)
	}
	if _, err := s.TaskByMessage(ctx, "nope"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
	if _, err := s.Task(ctx, "t9"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
}

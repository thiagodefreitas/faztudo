package tasks

import (
	"testing"

	"github.com/thiagodefreitas/faztudo/internal/domain"
)

func ptr[T any](v T) *T { return &v }

func TestApplyChangesOnlyWhatWasSent(t *testing.T) {
	task := domain.Task{Title: "Old", Assignee: "coder", Mode: domain.RunRead, Status: domain.TaskTodo, Order: 3, Checks: []string{"go test"}}
	got, err := Apply(task, Patch{Title: ptr("  New "), Mode: ptr(domain.RunWrite), Order: ptr(1.5)})
	if err != nil {
		t.Fatal(err)
	}
	if got.Title != "New" || got.Mode != domain.RunWrite || got.Order != 1.5 || got.Assignee != "coder" || len(got.Checks) != 1 {
		t.Fatalf("got %+v", got)
	}
}

func TestApplyRefusesRunningTasksAndEmptyTitles(t *testing.T) {
	if _, err := Apply(domain.Task{Title: "x", Assignee: "coder", Status: domain.TaskRunning}, Patch{Title: ptr("y")}); err == nil {
		t.Error("a running task must not be edited")
	}
	if _, err := Apply(domain.Task{Title: "x", Assignee: "coder", Status: domain.TaskTodo}, Patch{Title: ptr(" ")}); err == nil {
		t.Error("an empty title must be refused")
	}
}

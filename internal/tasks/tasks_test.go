package tasks

import (
	"strings"
	"testing"

	"github.com/thiagodefreitas/faztudo/internal/domain"
)

func TestNormalizeTrimsAndDefaults(t *testing.T) {
	got, err := Normalize(Input{Title: "  Fix the login  ", Assignee: "@Coder", Scope: []string{" web/ ", "", "internal/api"}, Checks: []string{"go test ./..."}})
	if err != nil {
		t.Fatal(err)
	}
	if got.Title != "Fix the login" || got.Assignee != "coder" || got.Mode != domain.RunRead {
		t.Fatalf("got %+v", got)
	}
	if len(got.Scope) != 2 || got.Scope[0] != "web/" || got.Acceptance == nil {
		t.Fatalf("lists not cleaned: %+v", got)
	}
}

func TestNormalizeRefusesBadInput(t *testing.T) {
	many := make([]string, 21)
	for i := range many {
		many[i] = "c"
	}
	cases := map[string]Input{
		"no title":    {Assignee: "coder"},
		"no assignee": {Title: "x"},
		"bad mode":    {Title: "x", Assignee: "coder", Mode: "sudo"},
		"long title":  {Title: strings.Repeat("a", 201), Assignee: "coder"},
		"many items":  {Title: "x", Assignee: "coder", Checks: many},
		"bad lane":    {Title: "x", Assignee: "coder", Lane: "a b"},
	}
	for name, in := range cases {
		if _, err := Normalize(in); err == nil {
			t.Errorf("%s: want an error", name)
		}
	}
}

func TestRenderPutsDirectiveInSections(t *testing.T) {
	task := domain.Task{Title: "Fix the login", Body: "The form drops the password.", Assignee: "coder", Mode: domain.RunWrite,
		Scope: []string{"web/src/login.tsx"}, Checks: []string{"npm test"}, Acceptance: []string{"Login works", "No console errors"}}
	got := Render(task)
	for _, want := range []string{"@coder Task: Fix the login", "The form drops the password.", "Scope (stay inside it):\n- web/src/login.tsx", "Checks (run them and report the result):\n- npm test", "Acceptance criteria:\n- Login works\n- No console errors"} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in:\n%s", want, got)
		}
	}
}

func TestRenderOmitsEmptySections(t *testing.T) {
	got := Render(domain.Task{Title: "Look", Assignee: "reviewer", Mode: domain.RunRead})
	if strings.Contains(got, "Scope") || strings.Contains(got, "Checks") || strings.Contains(got, "Acceptance") {
		t.Fatalf("empty sections shown:\n%s", got)
	}
}

func run(id, msg string, state domain.RunState) domain.Run {
	return domain.Run{ID: id, TriggerMessageID: msg, State: state}
}

func TestDerive(t *testing.T) {
	started := domain.Task{ID: "t", MessageID: "m", Status: domain.TaskRunning}
	pending := []domain.Approval{{ID: "a", RunID: "r1", State: domain.ApprovalPending}}
	resolved := []domain.Approval{{ID: "a", RunID: "r1", State: domain.ApprovalResolved}}
	cases := []struct {
		name      string
		task      domain.Task
		runs      []domain.Run
		approvals []domain.Approval
		finished  bool
		want      domain.TaskStatus
	}{
		{"todo stays todo", domain.Task{Status: domain.TaskTodo}, nil, nil, true, domain.TaskTodo},
		{"started, no run yet", started, nil, nil, false, domain.TaskRunning},
		{"never ran", started, nil, nil, true, domain.TaskFailed},
		{"queued", started, []domain.Run{run("r1", "m", domain.RunQueued)}, nil, false, domain.TaskRunning},
		{"running", started, []domain.Run{run("r1", "m", domain.RunRunning)}, nil, false, domain.TaskRunning},
		{"waiting for approval", started, []domain.Run{run("r1", "m", domain.RunWaitingApproval)}, nil, false, domain.TaskReview},
		{"read run done", started, []domain.Run{run("r1", "m", domain.RunDone)}, nil, true, domain.TaskDone},
		{"failed", started, []domain.Run{run("r1", "m", domain.RunFailed)}, nil, true, domain.TaskFailed},
		{"retry wins over first failure", started, []domain.Run{run("r1", "m", domain.RunFailed), run("r2", "m", domain.RunRunning)}, nil, false, domain.TaskRunning},
		{"other message ignored", started, []domain.Run{run("r1", "other", domain.RunFailed)}, nil, false, domain.TaskRunning},
		{"approval pending", started, []domain.Run{run("r1", "m", domain.RunWaitingApproval)}, pending, false, domain.TaskReview},
		{"approval resolved", started, []domain.Run{run("r1", "m", domain.RunDone)}, resolved, true, domain.TaskDone},
		{"cancelled task is sticky", domain.Task{MessageID: "m", Status: domain.TaskCancelled}, []domain.Run{run("r1", "m", domain.RunRunning)}, nil, false, domain.TaskCancelled},
	}
	for _, c := range cases {
		got, _ := Derive(c.task, c.runs, c.approvals, c.finished)
		if got.Status != c.want {
			t.Errorf("%s: status %s, want %s", c.name, got.Status, c.want)
		}
	}
}

func TestDeriveLinksRunsAndApproval(t *testing.T) {
	task := domain.Task{ID: "t", MessageID: "m", Status: domain.TaskRunning}
	runs := []domain.Run{run("r1", "m", domain.RunFailed), run("r2", "m", domain.RunWaitingApproval)}
	approvals := []domain.Approval{{ID: "a1", RunID: "r2", State: domain.ApprovalPending}}
	got, changed := Derive(task, runs, approvals, false)
	if !changed || len(got.RunIDs) != 2 || got.RunIDs[1] != "r2" || got.ApprovalID != "a1" {
		t.Fatalf("got %+v changed=%v", got, changed)
	}
	if _, changed = Derive(got, runs, approvals, false); changed {
		t.Fatal("same facts must report no change")
	}
}

func TestEditableOnlyWhileTodo(t *testing.T) {
	if !Editable(domain.Task{Status: domain.TaskTodo}) || Editable(domain.Task{Status: domain.TaskRunning}) {
		t.Fatal("only a todo task can be edited")
	}
}

// Package tasks holds the rules for task directives: checking what a person
// typed, rendering it as the message that starts a run, and working out where
// a task stands from the runs and approvals that report back to it. It has no
// storage; the app persists tasks as events.
package tasks

import (
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/thiagodefreitas/faztudo/internal/domain"
)

const (
	maxTitle = 200
	maxBody  = 8000
	maxItems = 20
	maxItem  = 500
)

// Input is what a person fills in. Normalize makes it safe to store.
type Input struct {
	Title      string         `json:"title"`
	Body       string         `json:"body"`
	Assignee   string         `json:"assignee"`
	Lane       string         `json:"lane"`
	Mode       domain.RunMode `json:"mode"`
	Scope      []string       `json:"scope"`
	Checks     []string       `json:"checks"`
	Acceptance []string       `json:"acceptance"`
}

// Normalize trims the input, drops empty list items and fills defaults. Its
// errors are written for the person.
func Normalize(in Input) (Input, error) {
	in.Title = strings.TrimSpace(in.Title)
	in.Body = strings.TrimSpace(in.Body)
	in.Assignee = strings.ToLower(strings.TrimPrefix(strings.TrimSpace(in.Assignee), "@"))
	in.Lane = strings.TrimSpace(in.Lane)
	switch {
	case in.Title == "":
		return in, errors.New("a task needs a title")
	case len([]rune(in.Title)) > maxTitle:
		return in, fmt.Errorf("the title is longer than %d characters", maxTitle)
	case len(in.Body) > maxBody:
		return in, fmt.Errorf("the directive is longer than %d characters", maxBody)
	case in.Assignee == "":
		return in, errors.New("a task needs an assignee")
	case strings.ContainsAny(in.Lane, " \t\r\n"):
		return in, errors.New("a lane id has no spaces")
	}
	switch in.Mode {
	case "":
		in.Mode = domain.RunRead
	case domain.RunRead, domain.RunWrite:
	default:
		return in, errors.New("mode must be read or write")
	}
	var err error
	if in.Scope, err = cleanList("scope", in.Scope); err != nil {
		return in, err
	}
	if in.Checks, err = cleanList("checks", in.Checks); err != nil {
		return in, err
	}
	if in.Acceptance, err = cleanList("acceptance criteria", in.Acceptance); err != nil {
		return in, err
	}
	return in, nil
}

func cleanList(name string, items []string) ([]string, error) {
	out := []string{}
	for _, item := range items {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		if len([]rune(item)) > maxItem {
			return nil, fmt.Errorf("an item in %s is longer than %d characters", name, maxItem)
		}
		out = append(out, item)
	}
	if len(out) > maxItems {
		return nil, fmt.Errorf("%s has more than %d items", name, maxItems)
	}
	return out, nil
}

// Editable reports whether the directive can still be changed.
func Editable(t domain.Task) bool { return t.Status == domain.TaskTodo }

// Render is the message that starts the task: the agent is mentioned, the
// directive follows, and scope, checks and acceptance are their own sections.
// The run prompt carries this message as the request.
func Render(t domain.Task) string {
	var b strings.Builder
	fmt.Fprintf(&b, "@%s Task: %s\n", t.Assignee, t.Title)
	if t.Body != "" {
		b.WriteString("\n" + t.Body + "\n")
	}
	section(&b, "Scope (stay inside it):", t.Scope)
	section(&b, "Checks (run them and report the result):", t.Checks)
	section(&b, "Acceptance criteria:", t.Acceptance)
	return strings.TrimRight(b.String(), "\n")
}

func section(b *strings.Builder, title string, items []string) {
	if len(items) == 0 {
		return
	}
	b.WriteString("\n" + title + "\n")
	for _, item := range items {
		b.WriteString("- " + item + "\n")
	}
}

// Derive works out where a started task stands from the runs and approvals
// that belong to its message. finished says the code that handles the message
// has returned, so a task that never got a run has failed. It returns the
// updated task and whether anything changed. Todo and cancelled tasks never
// change: the first has not started, the second was a human's decision.
func Derive(t domain.Task, runs []domain.Run, approvals []domain.Approval, finished bool) (domain.Task, bool) {
	if t.MessageID == "" || t.Status == domain.TaskTodo || t.Status == domain.TaskCancelled {
		return t, false
	}
	mine := []domain.Run{}
	for _, r := range runs {
		if r.TriggerMessageID == t.MessageID {
			mine = append(mine, r)
		}
	}
	slices.SortFunc(mine, func(a, b domain.Run) int { return strings.Compare(a.ID, b.ID) })
	next := t
	next.RunIDs = make([]string, 0, len(mine))
	for _, r := range mine {
		next.RunIDs = append(next.RunIDs, r.ID)
	}
	next.ApprovalID = ""
	var pending bool
	for _, a := range approvals {
		if slices.Contains(next.RunIDs, a.RunID) {
			next.ApprovalID = a.ID
			pending = a.State == domain.ApprovalPending
		}
	}
	switch {
	case len(mine) == 0 && finished:
		next.Status = domain.TaskFailed
	case len(mine) == 0:
		next.Status = domain.TaskRunning
	default:
		last := mine[len(mine)-1]
		switch {
		case pending || last.State == domain.RunWaitingApproval:
			next.Status = domain.TaskReview
		case last.State == domain.RunFailed:
			next.Status = domain.TaskFailed
		case last.State == domain.RunCancelled:
			next.Status = domain.TaskCancelled
		case last.State == domain.RunDone:
			next.Status = domain.TaskDone
		default:
			next.Status = domain.TaskRunning
		}
	}
	changed := next.Status != t.Status || next.ApprovalID != t.ApprovalID || !slices.Equal(next.RunIDs, t.RunIDs)
	return next, changed
}

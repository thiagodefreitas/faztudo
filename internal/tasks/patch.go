package tasks

import (
	"errors"

	"github.com/thiagodefreitas/faztudo/internal/domain"
)

// Patch is a partial change to a todo task. Nil fields stay as they are.
type Patch struct {
	Title      *string         `json:"title"`
	Body       *string         `json:"body"`
	Assignee   *string         `json:"assignee"`
	Lane       *string         `json:"lane"`
	Mode       *domain.RunMode `json:"mode"`
	Scope      *[]string       `json:"scope"`
	Checks     *[]string       `json:"checks"`
	Acceptance *[]string       `json:"acceptance"`
	Order      *float64        `json:"order"`
}

// Apply returns t with the patch applied and the result checked again.
func Apply(t domain.Task, p Patch) (domain.Task, error) {
	if !Editable(t) {
		return t, errors.New("only a task in Todo can be changed")
	}
	in := Input{Title: t.Title, Body: t.Body, Assignee: t.Assignee, Lane: t.Lane, Mode: t.Mode, Scope: t.Scope, Checks: t.Checks, Acceptance: t.Acceptance}
	if p.Title != nil {
		in.Title = *p.Title
	}
	if p.Body != nil {
		in.Body = *p.Body
	}
	if p.Assignee != nil {
		in.Assignee = *p.Assignee
	}
	if p.Lane != nil {
		in.Lane = *p.Lane
	}
	if p.Mode != nil {
		in.Mode = *p.Mode
	}
	if p.Scope != nil {
		in.Scope = *p.Scope
	}
	if p.Checks != nil {
		in.Checks = *p.Checks
	}
	if p.Acceptance != nil {
		in.Acceptance = *p.Acceptance
	}
	in, err := Normalize(in)
	if err != nil {
		return t, err
	}
	t.Title, t.Body, t.Assignee, t.Lane, t.Mode = in.Title, in.Body, in.Assignee, in.Lane, in.Mode
	t.Scope, t.Checks, t.Acceptance = in.Scope, in.Checks, in.Acceptance
	if p.Order != nil {
		t.Order = *p.Order
	}
	return t, nil
}

package store

import (
	"context"
	"errors"
	"path/filepath"
	"slices"
	"testing"

	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
)

func TestOrgProjectionSurvivesRebuild(t *testing.T) {
	ctx := context.Background()
	s, err := Open(filepath.Join(t.TempDir(), "db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	dept := domain.Department{Handle: "engineering", DisplayName: "Engineering", Lead: "coder", Members: []string{"coder"}}
	project := domain.Project{Handle: "faztudo", Name: "Faztudo", Channels: []string{"dev"}, Departments: []string{}, Specialists: []string{}}
	for _, d := range []events.Draft{
		{Type: events.DepartmentUpdated, Actor: events.System, Payload: dept},
		{Type: events.ProjectUpdated, Actor: events.System, Payload: project},
	} {
		if _, err = s.Append(ctx, d); err != nil {
			t.Fatal(err)
		}
	}
	// The Director assigns a department later; the newest event wins.
	project.Departments = []string{"engineering"}
	if _, err = s.Append(ctx, events.Draft{Type: events.ProjectUpdated, Actor: events.Human("h"), Payload: project}); err != nil {
		t.Fatal(err)
	}
	if err = s.Rebuild(ctx); err != nil {
		t.Fatal(err)
	}
	depts, err := s.Departments(ctx)
	if err != nil || len(depts) != 1 || depts[0].Lead != "coder" {
		t.Fatalf("departments %+v, %v", depts, err)
	}
	got, err := s.Project(ctx, "faztudo")
	if err != nil || !slices.Equal(got.Departments, []string{"engineering"}) {
		t.Fatalf("project %+v, %v", got, err)
	}
	if _, err = s.Project(ctx, "missing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing project: %v", err)
	}
}

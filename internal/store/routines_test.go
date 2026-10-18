package store

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
)

func TestRoutineProjectionSurvivesRebuild(t *testing.T) {
	ctx := context.Background()
	s, err := Open(filepath.Join(t.TempDir(), "db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	r := domain.Routine{Handle: "daily-debrief", Name: "Daily debrief", Persona: "chief", Channel: "general", Schedule: "0 18 * * *", Enabled: true}
	if _, err = s.Append(ctx, events.Draft{Type: events.RoutineUpdated, Actor: events.System, Payload: r}); err != nil {
		t.Fatal(err)
	}
	// The newest event wins: the Director turns it off, then it runs once.
	r.Enabled = false
	r.Last = &domain.RoutineResult{At: time.Now().UTC(), Status: "ok", Detail: "posted"}
	if _, err = s.Append(ctx, events.Draft{Type: events.RoutineUpdated, Actor: events.Human("h"), Payload: r}); err != nil {
		t.Fatal(err)
	}
	if err = s.Rebuild(ctx); err != nil {
		t.Fatal(err)
	}
	got, err := s.Routine(ctx, "daily-debrief")
	if err != nil || got.Enabled || got.Last == nil || got.Last.Status != "ok" {
		t.Fatalf("routine %+v, %v", got, err)
	}
	all, err := s.Routines(ctx)
	if err != nil || len(all) != 1 {
		t.Fatalf("routines %+v, %v", all, err)
	}
	if _, err = s.Routine(ctx, "missing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing routine: %v", err)
	}
	// A routine must not show up as a project or a department.
	if projects, _ := s.Projects(ctx); len(projects) != 0 {
		t.Fatalf("routine leaked into projects: %+v", projects)
	}
}

func TestHandoffEventIsKeptInTheLog(t *testing.T) {
	ctx := context.Background()
	s, err := Open(filepath.Join(t.TempDir(), "db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	h := domain.Handoff{RequestID: "req", From: "chief", To: "coder", Depth: 1}
	if _, err = s.Append(ctx, events.Draft{Type: events.HandoffCreated, Actor: events.Agent("a"), ChannelID: "room", Payload: h}); err != nil {
		t.Fatal(err)
	}
	if err = s.Rebuild(ctx); err != nil {
		t.Fatal(err)
	}
	evs, err := s.EventsAfter(ctx, 0, 10)
	if err != nil || len(evs) != 1 || evs[0].Type != events.HandoffCreated {
		t.Fatalf("events %+v, %v", evs, err)
	}
}

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

func appRoutineCount(t *testing.T, s *Store) int {
	t.Helper()
	var n int
	if err := s.db.QueryRow("SELECT count(*) FROM app_routines").Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestAppRoutineRoundTripRemovalAndRebuild(t *testing.T) {
	ctx := context.Background()
	s, err := Open(filepath.Join(t.TempDir(), "db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	made := time.Date(2026, time.October, 22, 9, 0, 0, 0, time.UTC)
	r := domain.Routine{Handle: "check-build", Name: "Check build", Prompt: "Check the build.", Persona: "coder", Channel: "general", Schedule: "0 9 * * 1-5", Enabled: true, Source: "app", CreatedBy: "ada", CreatedAt: &made}
	if _, err = s.Append(ctx, events.Draft{Type: events.RoutineUpdated, Actor: events.Human("ada"), Payload: r}); err != nil {
		t.Fatal(err)
	}
	var name, prompt, createdAt string
	var enabled bool
	row := s.db.QueryRow("SELECT name,prompt,enabled,created_at FROM app_routines WHERE handle='check-build'")
	if err = row.Scan(&name, &prompt, &enabled, &createdAt); err != nil || name != "Check build" || prompt != "Check the build." || !enabled || createdAt != made.Format(time.RFC3339Nano) {
		t.Fatalf("row %q %q %v %q, %v", name, prompt, enabled, createdAt, err)
	}

	// Switching it off and recording a run keep the source and the creator.
	r.Enabled = false
	r.Last = &domain.RoutineResult{At: made, Status: "ok"}
	if _, err = s.Append(ctx, events.Draft{Type: events.RoutineUpdated, Actor: events.System, Payload: r}); err != nil {
		t.Fatal(err)
	}
	if err = s.Rebuild(ctx); err != nil {
		t.Fatal(err)
	}
	got, err := s.Routine(ctx, "check-build")
	if err != nil || got.Source != "app" || got.CreatedBy != "ada" || got.Enabled || got.Last == nil {
		t.Fatalf("routine %+v, %v", got, err)
	}
	if err = s.db.QueryRow("SELECT enabled FROM app_routines WHERE handle='check-build'").Scan(&enabled); err != nil || enabled {
		t.Fatalf("enabled %v, %v", enabled, err)
	}

	// Removal clears both tables, also after a rebuild.
	if _, err = s.Append(ctx, events.Draft{Type: events.RoutineRemoved, Actor: events.Human("ada"), Payload: map[string]string{"handle": "check-build"}}); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if _, err = s.Routine(ctx, "check-build"); !errors.Is(err, ErrNotFound) || appRoutineCount(t, s) != 0 {
			t.Fatalf("routine still there (pass %d): %v", i, err)
		}
		if err = s.Rebuild(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = s.Append(ctx, events.Draft{Type: events.RoutineRemoved, Actor: events.System, Payload: map[string]string{}}); err == nil {
		t.Fatal("a removal without a handle was accepted")
	}
}

func TestConfigRoutineTakesOverAnAppRoutineWithTheSameHandle(t *testing.T) {
	ctx := context.Background()
	s, err := Open(filepath.Join(t.TempDir(), "db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	r := domain.Routine{Handle: "nightly", Name: "Nightly", Prompt: "p", Persona: "coder", Channel: "general", Schedule: "0 2 * * *", Enabled: true, Source: "app", CreatedBy: "ada"}
	if _, err = s.Append(ctx, events.Draft{Type: events.RoutineUpdated, Actor: events.Human("ada"), Payload: r}); err != nil {
		t.Fatal(err)
	}
	r.Source, r.CreatedBy = "config", ""
	if _, err = s.Append(ctx, events.Draft{Type: events.RoutineUpdated, Actor: events.System, Payload: r}); err != nil {
		t.Fatal(err)
	}
	if appRoutineCount(t, s) != 0 {
		t.Fatal("the app copy was kept next to the lanes.toml one")
	}
	if got, err := s.Routine(ctx, "nightly"); err != nil || got.Source != "config" {
		t.Fatalf("routine %+v, %v", got, err)
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

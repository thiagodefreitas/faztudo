package lanes

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/eventstest"
)

func setConserve(t *testing.T, r *Registry, id string) {
	t.Helper()
	r.mu.Lock()
	r.lanes[id].Health, r.lanes[id].HealthReason = domain.LaneConserve, "usage at or above 80%"
	r.mu.Unlock()
}

func TestPickPrefersNonConserve(t *testing.T) {
	r, err := New([]LaneConfig{{ID: "a", Capacity: 1}, {ID: "b", Capacity: 1}, {ID: "c", Capacity: 1}}, []PersonaConfig{{Handle: "p", Lanes: []string{"a", "b", "c"}}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	setConserve(t, r, "a")
	l, skipped, err := r.Pick("p", "")
	if err != nil || l.ID != "b" || len(skipped) != 1 || skipped[0].ID != "a" || !strings.HasPrefix(skipped[0].Reason, "conserve") {
		t.Fatalf("%+v %+v %v", l, skipped, err)
	}
}

func TestPickUsesConserveOnlyWhenNothingElseIsUsable(t *testing.T) {
	r, _ := New([]LaneConfig{{ID: "a", Capacity: 1}, {ID: "b", Capacity: 1}}, []PersonaConfig{{Handle: "p", Lanes: []string{"a", "b"}}}, nil)
	setConserve(t, r, "a")
	r.mu.Lock()
	r.lanes["b"].Health, r.lanes["b"].HealthReason = domain.LaneExhausted, "quota"
	r.mu.Unlock()
	l, skipped, err := r.Pick("p", "")
	if err != nil || l.ID != "a" || l.Health != domain.LaneConserve || len(skipped) != 0 {
		t.Fatalf("%+v %+v %v", l, skipped, err)
	}
}

func TestPickWaitsForBusyHealthyLaneBeforeConserve(t *testing.T) {
	r, _ := New([]LaneConfig{{ID: "a", Capacity: 1}, {ID: "b", Capacity: 1}}, []PersonaConfig{{Handle: "p", Lanes: []string{"a", "b"}}}, &eventstest.Appender{})
	setConserve(t, r, "a")
	if err := r.Acquire("b"); err != nil {
		t.Fatal(err)
	}
	_, skipped, err := r.Pick("p", "")
	if err == nil || !onlyBusy(skipped) {
		t.Fatalf("conserve lane used while a healthy lane was only busy: %+v %v", skipped, err)
	}
}

func TestRunsTodayRollsOverAtLocalMidnight(t *testing.T) {
	log := &eventstest.Appender{}
	r, _ := New([]LaneConfig{{ID: "a", Capacity: 1}}, []PersonaConfig{{Handle: "p", Lanes: []string{"a"}}}, log)
	day := time.Date(2026, 10, 18, 23, 0, 0, 0, time.Local)
	r.now = func() time.Time { return day }
	r.RecordRun("a")
	r.RecordRun("a")
	if l, _ := r.Snapshot("a"); l.RunsToday != 2 || l.RunsDate != "2026-10-18" {
		t.Fatalf("%+v", l)
	}
	day = day.Add(2 * time.Hour)
	r.RecordRun("a")
	if l, _ := r.Snapshot("a"); l.RunsToday != 1 || l.RunsDate != "2026-10-19" {
		t.Fatalf("%+v", l)
	}
	drafts := log.Snapshot()
	if got := drafts[len(drafts)-1].Payload.(domain.Lane).RunsToday; got != 1 {
		t.Fatalf("published runs_today %d", got)
	}
	// Restore keeps today's count and drops an old day's.
	r2, _ := New([]LaneConfig{{ID: "a", Capacity: 1}}, nil, nil)
	r2.now = func() time.Time { return day }
	r2.Restore(domain.Lane{ID: "a", RunsToday: 4, RunsDate: "2026-10-19"})
	if l, _ := r2.Snapshot("a"); l.RunsToday != 4 {
		t.Fatalf("%+v", l)
	}
	r2.Restore(domain.Lane{ID: "a", RunsToday: 9, RunsDate: "2026-10-18"})
	if l, _ := r2.Snapshot("a"); l.RunsToday != 0 {
		t.Fatalf("%+v", l)
	}
}

func TestSetTokensLastHour(t *testing.T) {
	r, _ := New([]LaneConfig{{ID: "a", CLI: "claude", Capacity: 1}}, nil, &eventstest.Appender{})
	n := int64(1234)
	if err := r.SetTokensLastHour(context.Background(), "a", &n); err != nil {
		t.Fatal(err)
	}
	if l, _ := r.Snapshot("a"); l.TokensLastHour == nil || *l.TokensLastHour != 1234 {
		t.Fatalf("%+v", l)
	}
}

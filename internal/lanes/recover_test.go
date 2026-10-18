package lanes

import (
	"context"
	"testing"

	"github.com/thiagodefreitas/faztudo/internal/adapters"
	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/eventstest"
)

func TestRecoverClearsAnUnavailableLane(t *testing.T) {
	r, err := New([]LaneConfig{{ID: "a", CLI: "kimi", Capacity: 1}, {ID: "b", CLI: "codex", Capacity: 1}}, []PersonaConfig{{Handle: "coder", Lanes: []string{"a", "b"}}}, &eventstest.Appender{})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if err := r.Recover(ctx, "a", "probe"); err != nil {
		t.Fatal(err)
	}
	signal := adapters.LaneSignal{Kind: adapters.SignalUnavailable}
	if err := r.ApplySignal(ctx, "run", "coder", "a", signal, "403 subscription"); err != nil {
		t.Fatal(err)
	}
	l, _ := r.Snapshot("a")
	if l.Health != domain.LaneUnavailable || l.LastError == nil || l.LastError.Message != "403 subscription" {
		t.Fatalf("%+v", l)
	}
	if next, skipped, err := r.Pick("coder", ""); err != nil || next.ID != "b" || skipped[0].Reason != "403 subscription" {
		t.Fatalf("%+v %+v %v", next, skipped, err)
	}
	if _, _, err := r.Pick("coder", "a"); err == nil {
		t.Fatal("an explicit unavailable lane must not run")
	}
	if err := r.Recover(ctx, "a", "probe"); err != nil {
		t.Fatal(err)
	}
	l, _ = r.Snapshot("a")
	if l.Health != domain.LaneUnknown || l.LastError != nil {
		t.Fatalf("not recovered: %+v", l)
	}
	if next, _, err := r.Pick("coder", ""); err != nil || next.ID != "a" {
		t.Fatalf("%+v %v", next, err)
	}
}

package lanes

import (
	"context"
	"testing"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/adapters"
	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/eventstest"
)

// A slow run that succeeds must not clear a failure recorded after it started.
func TestRecoverSinceKeepsANewerFailure(t *testing.T) {
	r, err := New([]LaneConfig{{ID: "a", CLI: "kimi", Capacity: 2}}, []PersonaConfig{{Handle: "coder", Lanes: []string{"a"}}}, &eventstest.Appender{})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	started := time.Now().Add(-time.Minute)
	signal := adapters.LaneSignal{Kind: adapters.SignalUnavailable}
	if err := r.ApplySignal(ctx, "run", "coder", "a", signal, "403 subscription"); err != nil {
		t.Fatal(err)
	}
	if err := r.RecoverSince(ctx, "a", "last run succeeded", started); err != nil {
		t.Fatal(err)
	}
	l, _ := r.Snapshot("a")
	if l.Health != domain.LaneUnavailable || l.LastError == nil {
		t.Fatalf("a newer failure was cleared: %+v", l)
	}
	if err := r.RecoverSince(ctx, "a", "last run succeeded", time.Now().Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	l, _ = r.Snapshot("a")
	if l.Health != domain.LaneUnknown || l.LastError != nil {
		t.Fatalf("an older failure was kept: %+v", l)
	}
}

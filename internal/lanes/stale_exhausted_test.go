package lanes

import (
	"context"
	"testing"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/adapters"
	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/eventstest"
)

// exhaustedLane is a lane a failed run marked exhausted, with a reset time
// that has not passed yet.
func exhaustedLane(t *testing.T) *Registry {
	t.Helper()
	r, err := New([]LaneConfig{{ID: "a", CLI: "codex", Capacity: 1, ConserveAt: 80}}, []PersonaConfig{{Handle: "coder", Lanes: []string{"a"}}}, &eventstest.Appender{})
	if err != nil {
		t.Fatal(err)
	}
	signal := adapters.LaneSignal{Kind: adapters.SignalExhausted, Until: time.Now().Add(3 * time.Hour)}
	if err := r.ApplySignal(context.Background(), "run", "coder", "a", signal, "usage limit"); err != nil {
		t.Fatal(err)
	}
	return r
}

func reading(pct float64, age time.Duration, source domain.UsageSource) []domain.LaneWindow {
	at := time.Now().Add(-age)
	return []domain.LaneWindow{{Name: "5h", UsedPct: &pct, Source: source, MeasuredAt: &at}}
}

func TestHumanProbeClearsAStaleExhaustedState(t *testing.T) {
	ctx := context.Background()
	r := exhaustedLane(t)

	// The background ticker never clears it, however fresh the reading.
	if err := r.UpdateUsage(ctx, "a", reading(20, time.Minute, domain.SourceCLILog)); err != nil {
		t.Fatal(err)
	}
	if l, _ := r.Snapshot("a"); l.Health != domain.LaneExhausted || l.LastError == nil {
		t.Fatalf("the ticker cleared the exhausted state: %+v", l)
	}
	if _, _, err := r.Pick("coder", ""); err == nil {
		t.Fatal("an exhausted lane was picked")
	}

	// A human probe with a fresh reading below the conserve threshold does.
	if err := r.UpdateUsageAsked(ctx, "a", reading(20, time.Minute, domain.SourceProbe), true); err != nil {
		t.Fatal(err)
	}
	l, _ := r.Snapshot("a")
	if l.Health != domain.LaneAvailable || l.HealthReason != "cleared by probe" || l.LastError != nil {
		t.Fatalf("not cleared by the probe: %+v", l)
	}
	if next, _, err := r.Pick("coder", ""); err != nil || next.ID != "a" {
		t.Fatalf("cleared lane not usable: %+v %v", next, err)
	}
}

func TestHumanProbeKeepsExhaustedWhenTheReadingDoesNotClearIt(t *testing.T) {
	ctx := context.Background()
	for name, windows := range map[string][]domain.LaneWindow{
		"stale reading":     reading(20, time.Hour, domain.SourceProbe),
		"at conserve":       reading(85, time.Minute, domain.SourceProbe),
		"at the limit":      reading(100, time.Minute, domain.SourceProbe),
		"manual source":     reading(20, time.Minute, domain.SourceManual),
		"no reading at all": nil,
	} {
		t.Run(name, func(t *testing.T) {
			r := exhaustedLane(t)
			if err := r.UpdateUsageAsked(ctx, "a", windows, true); err != nil {
				t.Fatal(err)
			}
			if l, _ := r.Snapshot("a"); l.Health != domain.LaneExhausted || l.LastError == nil {
				t.Fatalf("exhausted state was cleared: %+v", l)
			}
		})
	}
}

func TestHumanProbeDoesNotRecoverAnUnavailableLane(t *testing.T) {
	ctx := context.Background()
	r, err := New([]LaneConfig{{ID: "a", CLI: "codex", Capacity: 1}}, nil, &eventstest.Appender{})
	if err != nil {
		t.Fatal(err)
	}
	if err := r.ApplySignal(ctx, "run", "coder", "a", adapters.LaneSignal{Kind: adapters.SignalUnavailable}, "login"); err != nil {
		t.Fatal(err)
	}
	if err := r.UpdateUsageAsked(ctx, "a", reading(20, time.Minute, domain.SourceProbe), true); err != nil {
		t.Fatal(err)
	}
	if l, _ := r.Snapshot("a"); l.Health != domain.LaneUnavailable {
		t.Fatalf("a usage reading recovered an unavailable lane: %+v", l)
	}
}

package lanes

import (
	"context"
	"testing"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/adapters"
	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/eventstest"
)

func TestAlertOnceUntilRecovery(t *testing.T) {
	log := &eventstest.Appender{}
	r, err := New([]LaneConfig{{ID: "a", CLI: "codex", Capacity: 1, ConserveAt: 80}}, nil, log)
	if err != nil {
		t.Fatal(err)
	}
	r.SetAlertChannels(func(context.Context, string) ([]string, error) { return []string{"ch"}, nil })
	now := time.Now()
	pct := 85.0
	for i := 0; i < 3; i++ {
		if err := r.UpdateUsage(context.Background(), "a", []domain.LaneWindow{{Name: "5h", UsedPct: &pct, Source: domain.SourceProbe, MeasuredAt: &now}}); err != nil {
			t.Fatal(err)
		}
	}
	alerts, notices := 0, 0
	for _, e := range log.Snapshot() {
		if e.Type == events.LaneAlert {
			alerts++
		}
		if e.Type == events.Notice {
			notices++
		}
	}
	if alerts != 1 || notices != 1 {
		t.Fatalf("alerts=%d notices=%d", alerts, notices)
	}
	pct = 10
	if err := r.UpdateUsage(context.Background(), "a", []domain.LaneWindow{{Name: "5h", UsedPct: &pct, Source: domain.SourceProbe, MeasuredAt: &now}}); err != nil {
		t.Fatal(err)
	}
	pct = 85
	if err := r.UpdateUsage(context.Background(), "a", []domain.LaneWindow{{Name: "5h", UsedPct: &pct, Source: domain.SourceProbe, MeasuredAt: &now}}); err != nil {
		t.Fatal(err)
	}
	alerts = 0
	for _, e := range log.Snapshot() {
		if e.Type == events.LaneAlert {
			alerts++
		}
	}
	if alerts != 2 {
		t.Fatalf("alerts=%d", alerts)
	}
}

func TestErrorAlertDoesNotDuplicateSwitchNotice(t *testing.T) {
	log := &eventstest.Appender{}
	r, err := New([]LaneConfig{{ID: "a", CLI: "codex", Capacity: 1}, {ID: "b", CLI: "claude", Capacity: 1}}, []PersonaConfig{{Handle: "coder", Lanes: []string{"a", "b"}}}, log)
	if err != nil {
		t.Fatal(err)
	}
	r.SetAlertChannels(func(context.Context, string) ([]string, error) { return []string{"ch"}, nil })
	for i := 0; i < 2; i++ {
		if err := r.ApplySignalForChannel(context.Background(), "run", "ch", "coder", "a", adapters.LaneSignal{Kind: adapters.SignalUnavailable}, "login expired"); err != nil {
			t.Fatal(err)
		}
	}
	notices, alerts := 0, 0
	for _, e := range log.Snapshot() {
		if e.Type == events.Notice && e.ChannelID == "ch" {
			notices++
		}
		if e.Type == events.LaneAlert {
			alerts++
		}
	}
	if notices != 1 || alerts != 1 {
		t.Fatalf("notices=%d alerts=%d", notices, alerts)
	}
}

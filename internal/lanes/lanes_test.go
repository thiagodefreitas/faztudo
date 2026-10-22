package lanes

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/adapters"
	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/eventstest"
)

func TestPickCapacityAndExhaustion(t *testing.T) {
	log := &eventstest.Appender{}
	r, err := New([]LaneConfig{{ID: "a", CLI: "codex", Capacity: 1}, {ID: "b", CLI: "claude", Capacity: 1}}, []PersonaConfig{{Handle: "coder", Lanes: []string{"a", "b"}}}, log)
	if err != nil {
		t.Fatal(err)
	}
	first, skipped, err := r.Pick("coder", "")
	if err != nil || first.ID != "a" || len(skipped) != 0 {
		t.Fatalf("%+v %+v %v", first, skipped, err)
	}
	if err := r.Acquire("a"); err != nil {
		t.Fatal(err)
	}
	second, skipped, err := r.Pick("coder", "")
	if err != nil || second.ID != "b" || len(skipped) != 1 || skipped[0].Reason != "at capacity" {
		t.Fatalf("%+v %+v %v", second, skipped, err)
	}
	r.Release("a")
	class, signal, _ := (adapters.Codex{}).Classify(1, "HTTP 402 quota exceeded")
	if class != domain.FailureSemantic {
		t.Fatal(class)
	}
	if err := r.ApplySignal(context.Background(), "run1", "coder", "a", signal, "quota exceeded"); err != nil {
		t.Fatal(err)
	}
	second, skipped, err = r.Pick("coder", "")
	if err != nil || second.ID != "b" || len(skipped) != 1 || skipped[0].Reason != "quota exceeded" {
		t.Fatalf("%+v %+v %v", second, skipped, err)
	}
	drafts := log.Snapshot()
	if len(drafts) != 6 || drafts[0].Type != events.LaneUpdated || drafts[1].Type != events.LaneUpdated || drafts[2].Type != events.LaneUpdated || drafts[3].Type != events.LaneAlert || drafts[4].Type != events.LaneSwitched || drafts[5].Type != events.Notice {
		t.Fatalf("%+v", drafts)
	}
	if drafts[0].Payload.(domain.Lane).Running != 1 || drafts[1].Payload.(domain.Lane).Running != 0 {
		t.Fatalf("running updates: %+v", drafts[:2])
	}
}

func TestOverride(t *testing.T) {
	r, _ := New([]LaneConfig{{ID: "a", Capacity: 1}, {ID: "b", Capacity: 1}}, []PersonaConfig{{Handle: "p", Lanes: []string{"a", "b"}}}, nil)
	l, _, err := r.Pick("p", "b")
	if err != nil || l.ID != "b" {
		t.Fatalf("%+v %v", l, err)
	}
	if _, _, err := r.Pick("p", "missing"); err == nil {
		t.Fatal("accepted unknown override")
	}
}

func TestWaitPickQueuesWhileBusy(t *testing.T) {
	r, err := New([]LaneConfig{{ID: "a", CLI: "codex", Capacity: 1}}, []PersonaConfig{{Handle: "coder", Lanes: []string{"a"}}}, &eventstest.Appender{})
	if err != nil {
		t.Fatal(err)
	}
	if err := r.Acquire("a"); err != nil {
		t.Fatal(err)
	}
	notified := make(chan []Skipped, 1)
	got := make(chan error, 1)
	go func() {
		lane, _, err := r.WaitPick(context.Background(), "coder", "", nil, func(s []Skipped) { notified <- s })
		if err == nil && lane.ID != "a" {
			err = fmt.Errorf("picked %s", lane.ID)
		}
		got <- err
	}()
	select {
	case s := <-notified:
		if len(s) != 1 || s[0].Reason != "at capacity" {
			t.Fatalf("notice for %+v", s)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no queued notice")
	}
	select {
	case err := <-got:
		t.Fatalf("returned while the lane was busy: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	r.Release("a")
	select {
	case err := <-got:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("did not wake after release")
	}
}

func TestWaitPickFailsFastWhenExhausted(t *testing.T) {
	r, err := New([]LaneConfig{{ID: "a", CLI: "codex", Capacity: 1}}, []PersonaConfig{{Handle: "coder", Lanes: []string{"a"}}}, &eventstest.Appender{})
	if err != nil {
		t.Fatal(err)
	}
	r.Restore(domain.Lane{ID: "a", CLI: "codex", Capacity: 1, Health: domain.LaneExhausted, HealthReason: "quota"})
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, _, err := r.WaitPick(ctx, "coder", "", nil, nil); err == nil || errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("want immediate failure, got %v", err)
	}
}

func TestRestoredExhaustionEndsAtItsReset(t *testing.T) {
	cfg := []LaneConfig{{ID: "a", CLI: "codex", Capacity: 1}}
	personas := []PersonaConfig{{Handle: "coder", Lanes: []string{"a"}}}
	past := time.Now().Add(-time.Minute).UTC()
	future := time.Now().Add(time.Hour).UTC()
	for _, tc := range []struct {
		name   string
		reset  *time.Time
		usable bool
	}{
		{"reset passed", &past, true},
		{"reset ahead", &future, false},
		{"no reset known, failed just now", nil, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r, err := New(cfg, personas, &eventstest.Appender{})
			if err != nil {
				t.Fatal(err)
			}
			r.Restore(domain.Lane{ID: "a", CLI: "codex", Capacity: 1, Health: domain.LaneExhausted, HealthReason: "quota",
				LastError: &domain.LaneError{Class: "exhausted", Message: "quota", ResetAt: tc.reset, At: time.Now()}})
			_, _, err = r.Pick("coder", "")
			if (err == nil) != tc.usable {
				t.Fatalf("usable=%v, pick error %v", tc.usable, err)
			}
		})
	}
}

func TestExhaustionRecordsItsReset(t *testing.T) {
	r, err := New([]LaneConfig{{ID: "a", CLI: "codex", Capacity: 1}}, []PersonaConfig{{Handle: "coder", Lanes: []string{"a"}}}, &eventstest.Appender{})
	if err != nil {
		t.Fatal(err)
	}
	until := time.Now().Add(2 * time.Hour)
	if err := r.ApplySignal(context.Background(), "run", "coder", "a", adapters.LaneSignal{Kind: adapters.SignalExhausted, Until: until}, "quota"); err != nil {
		t.Fatal(err)
	}
	l, _ := r.Snapshot("a")
	if l.LastError == nil || l.LastError.ResetAt == nil || !l.LastError.ResetAt.Equal(until.UTC()) {
		t.Fatalf("reset not recorded: %+v", l.LastError)
	}
}

func TestUsageHealth(t *testing.T) {
	now := time.Now().UTC()
	pct := func(v float64) *float64 { return &v }
	window := func(v *float64, source domain.UsageSource, age time.Duration) domain.LaneWindow {
		at := now.Add(-age)
		return domain.LaneWindow{Name: "5h", UsedPct: v, Source: source, MeasuredAt: &at}
	}
	tests := []struct {
		name      string
		cli       string
		threshold int
		windows   []domain.LaneWindow
		want      domain.LaneHealth
		reason    string
	}{
		{"no windows", "codex", 0, nil, domain.LaneUnknown, "no measurement"},
		{"available", "codex", 0, []domain.LaneWindow{window(pct(11), domain.SourceCLILog, time.Minute), window(pct(79.9), domain.SourceProbe, time.Minute)}, domain.LaneAvailable, "cli-log"},
		{"conserve boundary", "codex", 0, []domain.LaneWindow{window(pct(80), domain.SourceProbe, time.Minute)}, domain.LaneConserve, "80"},
		{"custom threshold", "codex", 60, []domain.LaneWindow{window(pct(65), domain.SourceProbe, time.Minute)}, domain.LaneConserve, "60"},
		{"exhausted overrides missing", "codex", 0, []domain.LaneWindow{window(pct(100), domain.SourceProbe, time.Minute), window(nil, domain.SourceUnknown, 0)}, domain.LaneExhausted, "100"},
		{"missing", "codex", 0, []domain.LaneWindow{window(nil, domain.SourceUnknown, 0)}, domain.LaneUnknown, "no measurement"},
		{"stale", "codex", 0, []domain.LaneWindow{window(pct(20), domain.SourceProbe, 40*time.Minute)}, domain.LaneUnknown, "40m old"},
		{"boundary stale", "codex", 0, []domain.LaneWindow{window(pct(20), domain.SourceProbe, 15*time.Minute)}, domain.LaneUnknown, "15m old"},
		{"manual value", "codex", 0, []domain.LaneWindow{window(pct(20), domain.SourceManual, time.Minute)}, domain.LaneUnknown, "no measurement"},
		{"invalid percentage", "codex", 0, []domain.LaneWindow{window(pct(-1), domain.SourceProbe, time.Minute)}, domain.LaneUnknown, "no measurement"},
		{"claude tokens", "claude", 0, []domain.LaneWindow{window(nil, domain.SourceCLILog, time.Minute)}, domain.LaneUnknown, "manual plan limit"},
		{"claude no data", "claude", 0, []domain.LaneWindow{window(nil, domain.SourceUnknown, time.Minute)}, domain.LaneUnknown, "no measurement"},
		{"claude plan limit", "claude", 0, []domain.LaneWindow{window(pct(30), domain.SourceCLILog, time.Minute)}, domain.LaneAvailable, "cli-log"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r, err := New([]LaneConfig{{ID: "a", CLI: tt.cli, Capacity: 1, ConserveAt: tt.threshold}}, nil, nil)
			if err != nil {
				t.Fatal(err)
			}
			if err := r.UpdateUsage(context.Background(), "a", tt.windows); err != nil {
				t.Fatal(err)
			}
			got, _ := r.Snapshot("a")
			if got.Health != tt.want || !strings.Contains(got.HealthReason, tt.reason) {
				t.Fatalf("health %s reason %q, want %s containing %q", got.Health, got.HealthReason, tt.want, tt.reason)
			}
		})
	}
}

func TestUsageRecoveryAndQuotaSignal(t *testing.T) {
	now := time.Now().UTC()
	pct := 100.0
	windows := []domain.LaneWindow{{Name: "5h", Source: domain.SourceProbe, UsedPct: &pct, MeasuredAt: &now}}
	r, err := New([]LaneConfig{{ID: "a", CLI: "codex", Capacity: 1}}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := r.UpdateUsage(context.Background(), "a", windows); err != nil {
		t.Fatal(err)
	}
	pct = 20
	if err := r.UpdateUsage(context.Background(), "a", windows); err != nil {
		t.Fatal(err)
	}
	got, _ := r.Snapshot("a")
	if got.Health != domain.LaneAvailable {
		t.Fatalf("fresh lower reading left health %s", got.Health)
	}
	signal := adapters.LaneSignal{Kind: adapters.SignalExhausted, Until: now.Add(time.Hour)}
	if err := r.ApplySignal(context.Background(), "run", "", "a", signal, "quota exceeded"); err != nil {
		t.Fatal(err)
	}
	if err := r.UpdateUsage(context.Background(), "a", windows); err != nil {
		t.Fatal(err)
	}
	got, _ = r.Snapshot("a")
	if got.Health != domain.LaneExhausted {
		t.Fatalf("quota signal was cleared: %s", got.Health)
	}
}

func TestUsageExpiresWithoutNewProbe(t *testing.T) {
	now := time.Now().UTC()
	pct := 12.0
	log := &eventstest.Appender{}
	r, err := New([]LaneConfig{{ID: "a", CLI: "codex", Capacity: 1}}, nil, log)
	if err != nil {
		t.Fatal(err)
	}
	if err := r.UpdateUsage(context.Background(), "a", []domain.LaneWindow{{Name: "5h", UsedPct: &pct, Source: domain.SourceProbe, MeasuredAt: &now}}); err != nil {
		t.Fatal(err)
	}
	r.expireUsage("a", now.Add(16*time.Minute))
	got, _ := r.Snapshot("a")
	if got.Health != domain.LaneUnknown || !strings.Contains(got.HealthReason, "16m old") {
		t.Fatalf("expired health: %s %q", got.Health, got.HealthReason)
	}
	drafts := log.Snapshot()
	if len(drafts) != 3 || drafts[1].Type != events.LaneUsageRead || drafts[2].Payload.(domain.Lane).Health != domain.LaneUnknown {
		t.Fatalf("expiry events: %+v", drafts)
	}
}

// An exhaustion without a reset time is retried after unknownResetRetry
// instead of lasting until a manual reset.
func TestExhaustedWithoutResetIsRetried(t *testing.T) {
	r, _ := New([]LaneConfig{{ID: "a", Capacity: 1}}, []PersonaConfig{{Handle: "coder", Lanes: []string{"a"}}}, nil)
	if err := r.ApplySignal(context.Background(), "run", "coder", "a", adapters.LaneSignal{Kind: adapters.SignalExhausted}, "quota"); err != nil {
		t.Fatal(err)
	}
	if until := r.ResetAt("a"); until.IsZero() || time.Until(until) > unknownResetRetry {
		t.Fatalf("reset %v", until)
	}
}

func TestRestoredExhaustionWithoutResetExpires(t *testing.T) {
	r, _ := New([]LaneConfig{{ID: "a", Capacity: 1}}, []PersonaConfig{{Handle: "coder", Lanes: []string{"a"}}}, nil)
	r.Restore(domain.Lane{ID: "a", Health: domain.LaneExhausted, LastError: &domain.LaneError{Class: string(adapters.SignalExhausted), At: time.Now().Add(-2 * unknownResetRetry)}})
	if lane, _, err := r.Pick("coder", ""); err != nil || lane.ID != "a" {
		t.Fatalf("pick after the retry time: %+v %v", lane, err)
	}
}

func TestExpireResetsShowsAnUntriedLaneAgain(t *testing.T) {
	r, _ := New([]LaneConfig{{ID: "a", Capacity: 1}, {ID: "b", Capacity: 1}}, nil, nil)
	r.Restore(domain.Lane{ID: "a", Health: domain.LaneExhausted, LastError: &domain.LaneError{Class: string(adapters.SignalExhausted), At: time.Now().Add(-2 * unknownResetRetry)}})
	r.Restore(domain.Lane{ID: "b", Health: domain.LaneExhausted, LastError: &domain.LaneError{Class: string(adapters.SignalExhausted), At: time.Now()}})
	r.ExpireResets(time.Now())
	if a, _ := r.Snapshot("a"); a.Health != domain.LaneUnknown || a.HealthReason != "reset time passed" {
		t.Fatalf("a: %+v", a)
	}
	if b, _ := r.Snapshot("b"); b.Health != domain.LaneExhausted {
		t.Fatalf("b expired early: %+v", b)
	}
}

func TestCleanRunShowsALaneAvailableForAnHour(t *testing.T) {
	r, _ := New([]LaneConfig{{ID: "a", Capacity: 1}, {ID: "b", Capacity: 1}}, nil, nil)
	start := time.Now()
	r.RecordClean("a", start)
	if a, _ := r.Snapshot("a"); a.Health != domain.LaneAvailable || !strings.Contains(a.HealthReason, "finished cleanly") {
		t.Fatalf("after a clean run: %+v", a)
	}
	if b, _ := r.Snapshot("b"); b.Health != domain.LaneUnknown {
		t.Fatalf("untouched lane: %+v", b)
	}
	r.ExpireResets(start.Add(cleanRunFresh + time.Minute))
	if a, _ := r.Snapshot("a"); a.Health != domain.LaneUnknown {
		t.Fatalf("an old clean run still counts: %+v", a)
	}
}

func TestCleanRunDoesNotClearAnExhaustedLane(t *testing.T) {
	r, _ := New([]LaneConfig{{ID: "a", Capacity: 1}}, nil, nil)
	r.Restore(domain.Lane{ID: "a", Health: domain.LaneExhausted, LastError: &domain.LaneError{Class: string(adapters.SignalExhausted), At: time.Now()}})
	r.RecordClean("a", time.Now())
	if a, _ := r.Snapshot("a"); a.Health != domain.LaneExhausted {
		t.Fatalf("%+v", a)
	}
}

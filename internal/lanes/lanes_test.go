package lanes

import (
	"context"
	"errors"
	"fmt"
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
	if len(drafts) != 5 || drafts[0].Type != events.LaneUpdated || drafts[1].Type != events.LaneUpdated || drafts[2].Type != events.LaneUpdated || drafts[3].Type != events.LaneSwitched || drafts[4].Type != events.Notice {
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
		lane, _, err := r.WaitPick(context.Background(), "coder", "", func(s []Skipped) { notified <- s })
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
	if _, _, err := r.WaitPick(ctx, "coder", "", nil); err == nil || errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("want immediate failure, got %v", err)
	}
}

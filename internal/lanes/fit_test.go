package lanes

import (
	"context"
	"testing"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/eventstest"
)

func noReadOn(id string) func(domain.Lane) string {
	return func(l domain.Lane) string {
		if l.ID == id {
			return "agy has no read-only mode"
		}
		return ""
	}
}

func TestPickFitSkipsUnfitLane(t *testing.T) {
	r, _ := New([]LaneConfig{{ID: "agy", Capacity: 1}, {ID: "grok", Capacity: 1}}, []PersonaConfig{{Handle: "p", Lanes: []string{"agy", "grok"}}}, nil)
	l, skipped, err := r.PickFit("p", "", noReadOn("agy"))
	if err != nil || l.ID != "grok" || len(skipped) != 1 || skipped[0].Reason != "agy has no read-only mode" {
		t.Fatalf("%+v %+v %v", l, skipped, err)
	}
}

// The researcher case: the only read-capable lane is busy, so the run waits
// for it instead of falling through to a lane that cannot run read-only.
func TestWaitPickWaitsForBusyFitLaneOverUnfit(t *testing.T) {
	r, _ := New([]LaneConfig{{ID: "grok", Capacity: 1}, {ID: "agy", Capacity: 1}}, []PersonaConfig{{Handle: "p", Lanes: []string{"grok", "agy"}}}, &eventstest.Appender{})
	if err := r.Acquire("grok"); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	waited := make(chan struct{}, 1)
	go func() {
		<-waited
		r.Release("grok")
	}()
	l, _, err := r.WaitPick(ctx, "p", "", noReadOn("agy"), func([]Skipped) { waited <- struct{}{} })
	if err != nil || l.ID != "grok" {
		t.Fatalf("%+v %v", l, err)
	}
}

func TestPickFitAllUnfitFails(t *testing.T) {
	r, _ := New([]LaneConfig{{ID: "agy", Capacity: 1}}, []PersonaConfig{{Handle: "p", Lanes: []string{"agy"}}}, nil)
	if _, skipped, err := r.PickFit("p", "", noReadOn("agy")); err == nil || len(skipped) != 1 {
		t.Fatalf("%+v %v", skipped, err)
	}
}

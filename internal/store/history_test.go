package store

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
)

func TestLaneHistorySurvivesRebuild(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	for _, name := range []string{"5h", "day"} {
		reading := LaneUsageReading{LaneID: "a", Window: domain.LaneWindow{Name: name, Source: domain.SourceProbe, MeasuredAt: &now}, ReadAt: now}
		if _, err := s.Append(ctx, events.Draft{Type: events.LaneUsageRead, Actor: events.System, Payload: reading}); err != nil {
			t.Fatal(err)
		}
	}
	check := func() {
		got, err := s.LaneHistory(ctx, "a", "5h", now.Add(-time.Second))
		if err != nil || len(got) != 1 || got[0].Window.Name != "5h" {
			t.Fatalf("history: %+v %v", got, err)
		}
	}
	check()
	if err := s.Rebuild(ctx); err != nil {
		t.Fatal(err)
	}
	check()
}

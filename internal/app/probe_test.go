package app

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/thiagodefreitas/faztudo/internal/adapters"
	"github.com/thiagodefreitas/faztudo/internal/config"
	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/store"
)

func TestProbeUnsupportedCLIExplainsWhy(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	for _, id := range []string{"agy/flash", "agy/sonnet"} {
		lane := domain.Lane{ID: id, CLI: "agy", Capacity: 1, Health: domain.LaneAvailable}
		if _, err := s.Append(context.Background(), events.Draft{Type: events.LaneUpdated, Actor: events.System, Payload: lane}); err != nil {
			t.Fatal(err)
		}
	}
	a, err := New(context.Background(), s, config.Config{}, config.Paths{})
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"agy/flash", "agy/sonnet"} {
		_, err := a.ProbeLane(context.Background(), id)
		if err == nil || !strings.Contains(err.Error(), "this CLI has no probe") {
			t.Fatalf("%s: want clear unsupported probe error, got %v", id, err)
		}
	}
}

// The usage ticker calls RefreshUsage. It must read usage without giving an
// unavailable lane another chance; only a probe the human asked for does.
func TestUsageRefreshDoesNotRecoverAnUnavailableLane(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	s, err := store.Open(filepath.Join(t.TempDir(), "db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx := context.Background()
	lane := domain.Lane{ID: "a", CLI: "codex", Capacity: 1, Windows: []domain.LaneWindow{}}
	if _, err := s.Append(ctx, events.Draft{Type: events.LaneUpdated, Actor: events.System, Payload: lane}); err != nil {
		t.Fatal(err)
	}
	a, err := New(ctx, s, config.Config{}, config.Paths{})
	if err != nil {
		t.Fatal(err)
	}
	signal := adapters.LaneSignal{Kind: adapters.SignalUnavailable}
	if err := a.Registry.ApplySignal(ctx, "run", "coder", "a", signal, "403 subscription"); err != nil {
		t.Fatal(err)
	}
	health := func() domain.LaneHealth {
		got, err := s.Lane(ctx, "a")
		if err != nil {
			t.Fatal(err)
		}
		return got.Health
	}
	_ = a.RefreshUsage(ctx)
	if health() != domain.LaneUnavailable {
		t.Fatalf("the usage ticker recovered the lane: %s", health())
	}
	_, _ = a.ProbeLane(ctx, "a")
	if health() == domain.LaneUnavailable {
		t.Fatal("a probe the human asked for left the lane unavailable")
	}
}

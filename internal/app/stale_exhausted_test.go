package app

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/adapters"
	"github.com/thiagodefreitas/faztudo/internal/config"
	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/store"
)

// A failed run marks the lane exhausted until a guessed reset time. A fresh
// reading that says otherwise is ignored by the usage ticker but cleared by a
// probe the human asked for.
func TestProbeClearsStaleExhaustedStateButTickerDoesNot(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	now := time.Now().UTC()
	line := fmt.Sprintf(`{"type":"event_msg","timestamp":%q,"payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":10.0,"window_minutes":300,"resets_at":%d},"secondary":{"used_percent":5.0,"window_minutes":10080,"resets_at":%d}}}}`+"\n",
		now.Format(time.RFC3339), now.Add(4*time.Hour).Unix(), now.Add(48*time.Hour).Unix())
	dir := filepath.Join(home, ".codex", "sessions", now.Format("2006"), now.Format("01"), now.Format("02"))
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "rollout-fresh.jsonl"), []byte(line), 0600); err != nil {
		t.Fatal(err)
	}
	s, err := store.Open(filepath.Join(t.TempDir(), "db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx := context.Background()
	if _, err := s.Append(ctx, events.Draft{Type: events.LaneUpdated, Actor: events.System, Payload: domain.Lane{ID: "a", CLI: "codex", Capacity: 1, Windows: []domain.LaneWindow{}}}); err != nil {
		t.Fatal(err)
	}
	a, err := New(ctx, s, config.Config{}, config.Paths{})
	if err != nil {
		t.Fatal(err)
	}
	signal := adapters.LaneSignal{Kind: adapters.SignalExhausted, Until: now.Add(3 * time.Hour)}
	if err := a.Registry.ApplySignal(ctx, "run", "coder", "a", signal, "usage limit"); err != nil {
		t.Fatal(err)
	}
	health := func() (domain.LaneHealth, string) {
		got, err := s.Lane(ctx, "a")
		if err != nil {
			t.Fatal(err)
		}
		return got.Health, got.HealthReason
	}
	_ = a.RefreshUsage(ctx)
	if h, _ := health(); h != domain.LaneExhausted {
		t.Fatalf("the usage ticker cleared the exhausted state: %s", h)
	}
	if _, err := a.ProbeLane(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	if h, reason := health(); h != domain.LaneAvailable || reason != "cleared by probe" {
		t.Fatalf("a human probe left the lane %s (%q)", h, reason)
	}
}

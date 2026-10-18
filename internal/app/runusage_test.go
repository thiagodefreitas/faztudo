package app

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/config"
	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/store"
)

func TestRunRecordsItsTokensAndEstimatedCost(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	s, err := store.Open(filepath.Join(t.TempDir(), "db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx := context.Background()
	cfg := config.Config{}
	cfg.Lanes.Lane = []config.Lane{{ID: "claude/default", CLI: "claude", USDPerMillionInput: 3, USDPerMillionOutput: 15, USDPerMillionCached: 0.3}}
	a, err := New(ctx, s, cfg, config.Paths{})
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(home, ".claude", "projects", "-work-repo")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	log := `{"type":"assistant","timestamp":"` + time.Now().UTC().Format(time.RFC3339) + `","cwd":"/work/repo","message":{"id":"m1","usage":{"input_tokens":1000000,"output_tokens":100000,"cache_read_input_tokens":1000000}}}` + "\n"
	if err := os.WriteFile(filepath.Join(dir, "s.jsonl"), []byte(log), 0o600); err != nil {
		t.Fatal(err)
	}
	start := time.Now().UTC().Add(-time.Minute)
	end := time.Now().UTC().Add(time.Minute)
	run := domain.Run{ID: "r1", ChannelID: "ch", LaneID: "claude/default", StartedAt: &start, EndedAt: &end}
	if _, err := s.Append(ctx, events.Draft{Type: events.RunCreated, Actor: events.System, ChannelID: "ch", Payload: run}); err != nil {
		t.Fatal(err)
	}
	a.recordRunUsage(ctx, &run, "claude", "/work/repo")
	got, err := s.Run(ctx, "r1")
	if err != nil {
		t.Fatal(err)
	}
	if got.Tokens == nil || got.Tokens.Input != 1000000 || got.Tokens.Output != 100000 || got.Tokens.CacheRead != 1000000 {
		t.Fatalf("tokens: %+v", got.Tokens)
	}
	// 1M input at $3, 100k output at $15 per million, 1M cached at $0.3.
	if got.CostUSD == nil || *got.CostUSD < 4.79 || *got.CostUSD > 4.81 {
		t.Fatalf("cost: %v", got.CostUSD)
	}
}

func TestRunWithoutLogsKeepsUsageUnknown(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	s, err := store.Open(filepath.Join(t.TempDir(), "db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx := context.Background()
	a, err := New(ctx, s, config.Config{}, config.Paths{})
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now().UTC().Add(-time.Minute)
	end := time.Now().UTC()
	run := domain.Run{ID: "r2", ChannelID: "ch", LaneID: "kimi/default", StartedAt: &start, EndedAt: &end}
	if _, err := s.Append(ctx, events.Draft{Type: events.RunCreated, Actor: events.System, ChannelID: "ch", Payload: run}); err != nil {
		t.Fatal(err)
	}
	a.recordRunUsage(ctx, &run, "kimi", "/work/repo")
	got, _ := s.Run(ctx, "r2")
	if got.Tokens != nil || got.CostUSD != nil {
		t.Fatalf("unknown must stay unknown: %+v %v", got.Tokens, got.CostUSD)
	}
}

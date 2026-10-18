package app

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/thiagodefreitas/faztudo/internal/adapters"
	"github.com/thiagodefreitas/faztudo/internal/config"
	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/store"
)

func TestProjectAssignmentReceivesLaneAlert(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx := context.Background()
	drafts := []events.Draft{
		{Type: events.LaneUpdated, Actor: events.System, Payload: domain.Lane{ID: "a", CLI: "codex", Capacity: 1, Health: domain.LaneAvailable, Windows: []domain.LaneWindow{}}},
		{Type: events.MemberUpdated, Actor: events.System, Payload: domain.Member{ID: "agent", Kind: domain.MemberAgent, Handle: "coder", Agent: &domain.AgentInfo{Lanes: []string{"a"}}}},
		{Type: events.ChannelCreated, Actor: events.System, ChannelID: "ch", Payload: domain.Channel{ID: "ch", Name: "work"}},
		{Type: events.ProjectUpdated, Actor: events.System, Payload: domain.Project{Handle: "p", Name: "Project", Channels: []string{"work"}, Specialists: []string{"coder"}}},
	}
	for _, d := range drafts {
		if _, err := s.Append(ctx, d); err != nil {
			t.Fatal(err)
		}
	}
	a, err := New(ctx, s, config.Defaults(), config.Paths{})
	if err != nil {
		t.Fatal(err)
	}
	if err := a.Registry.ApplySignalForChannel(ctx, "run", "", "coder", "a", adapters.LaneSignal{Kind: adapters.SignalUnavailable}, "login expired"); err != nil {
		t.Fatal(err)
	}
	events, err := s.EventsAfter(ctx, 0, 100)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range events {
		if e.Type == "notice" && e.ChannelID == "ch" {
			return
		}
	}
	t.Fatal("project channel received no alert")
}

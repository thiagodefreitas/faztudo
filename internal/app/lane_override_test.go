package app

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/adapters"
	"github.com/thiagodefreitas/faztudo/internal/config"
	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/store"
)

func TestParseLaneOverride(t *testing.T) {
	for _, tc := range []struct {
		body, handle, lane, rest string
		found                    bool
	}{
		{"@coder /lane claude/opus fix x", "coder", "claude/opus", "@coder fix x", true},
		{"hey @Coder /lane claude/opus fix x", "coder", "claude/opus", "hey @Coder fix x", true},
		{"@coder /lane claude/opus", "coder", "claude/opus", "@coder", true},
		{"@coder fix x", "coder", "", "@coder fix x", false},
		{"@coder fix /lane claude/opus", "coder", "", "@coder fix /lane claude/opus", false},
		{"@coder /lane", "coder", "", "@coder /lane", false},
		{"@reviewer /lane codex/default look", "coder", "", "@reviewer /lane codex/default look", false},
		{"@coder /lane a/x do\n@reviewer /lane b/y check", "reviewer", "b/y", "@coder /lane a/x do\n@reviewer check", true},
	} {
		lane, rest, found := parseLaneOverride(tc.body, tc.handle)
		if lane != tc.lane || rest != tc.rest || found != tc.found {
			t.Fatalf("%q: got %q %q %v", tc.body, lane, rest, found)
		}
	}
}

func TestPinnedExhaustedLaneIsRefusedWithResetNotice(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx := context.Background()
	coder := domain.Member{ID: "m1", Kind: domain.MemberAgent, Handle: "coder", Agent: &domain.AgentInfo{Lanes: []string{"codex/default"}}}
	lane := domain.Lane{ID: "codex/default", CLI: "codex", Capacity: 1, Windows: []domain.LaneWindow{}}
	ch := domain.Channel{ID: "ch", Name: "work", Kind: domain.ChannelTeam, Visibility: domain.VisibilityPublic}
	for _, draft := range []events.Draft{{Type: events.LaneUpdated, Actor: events.System, Payload: lane}, {Type: events.MemberUpdated, Actor: events.System, Payload: coder}, {Type: events.ChannelCreated, Actor: events.System, ChannelID: ch.ID, Payload: ch}} {
		if _, err := s.Append(ctx, draft); err != nil {
			t.Fatal(err)
		}
	}
	a, err := New(ctx, s, config.Config{}, config.Paths{})
	if err != nil {
		t.Fatal(err)
	}
	reset := time.Now().Add(3 * time.Hour)
	if err := a.Registry.ApplySignal(ctx, "run", "coder", lane.ID, adapters.LaneSignal{Kind: adapters.SignalExhausted, Until: reset}, "usage limit"); err != nil {
		t.Fatal(err)
	}
	a.OnMessage(ctx, domain.Message{ID: store.NewID(), ChannelID: ch.ID, Body: "@coder /lane codex/default do it"}, []domain.Member{coder})
	want := "codex/default is out of quota until " + reset.Local().Format("15:04") + "; @coder did not run"
	deadline := time.Now().Add(2 * time.Second)
	for !noticeContaining(t, s, ch.ID, want) {
		if time.Now().After(deadline) {
			t.Fatalf("no immediate notice containing %q", want)
		}
		time.Sleep(10 * time.Millisecond)
	}
	runs, err := s.Runs(ctx, ch.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(runs) != 0 {
		t.Fatalf("pinned exhausted lane started %d runs", len(runs))
	}
	// A manual health override must clear the old reset signal before the
	// next pinned request, rather than revive exhaustion from the registry.
	lane, err = s.Lane(ctx, lane.ID)
	if err != nil {
		t.Fatal(err)
	}
	lane.Health, lane.HealthReason = domain.LaneAvailable, "manual override"
	if _, err := s.Append(ctx, events.Draft{Type: events.LaneUpdated, Actor: events.Human("human"), Payload: lane}); err != nil {
		t.Fatal(err)
	}
	if err := a.syncManualLane(ctx, lane.ID); err != nil {
		t.Fatal(err)
	}
	if got, ok := a.Registry.Snapshot(lane.ID); !ok || got.Health != domain.LaneAvailable || got.LastError != nil {
		t.Fatalf("manual override did not clear exhaustion: %+v", got)
	}
}

func TestOnMessageRejectsBadLaneOverride(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx := context.Background()
	for _, l := range []domain.Lane{{ID: "a", CLI: "codex", Capacity: 1, Windows: []domain.LaneWindow{}}, {ID: "b", CLI: "codex", Capacity: 1, Windows: []domain.LaneWindow{}}} {
		if _, err := s.Append(ctx, events.Draft{Type: events.LaneUpdated, Actor: events.System, Payload: l}); err != nil {
			t.Fatal(err)
		}
	}
	coder := domain.Member{ID: "m1", Kind: domain.MemberAgent, Handle: "coder", Agent: &domain.AgentInfo{Lanes: []string{"a"}}}
	if _, err := s.Append(ctx, events.Draft{Type: events.MemberUpdated, Actor: events.System, Payload: coder}); err != nil {
		t.Fatal(err)
	}
	ch := domain.Channel{ID: "ch", Name: "work", Kind: domain.ChannelTeam, Visibility: domain.VisibilityPublic}
	if _, err := s.Append(ctx, events.Draft{Type: events.ChannelCreated, Actor: events.System, ChannelID: ch.ID, Payload: ch}); err != nil {
		t.Fatal(err)
	}
	a, err := New(ctx, s, config.Config{}, config.Paths{})
	if err != nil {
		t.Fatal(err)
	}
	members, _ := s.Members(ctx)
	var agent domain.Member
	for _, m := range members {
		if m.Handle == "coder" {
			agent = m
		}
	}
	for body, want := range map[string]string{
		"@coder /lane nope do it": "Unknown lane nope",
		"@coder /lane b do it":    "not in @coder's chain",
	} {
		a.OnMessage(ctx, domain.Message{ID: store.NewID(), ChannelID: ch.ID, Body: body}, []domain.Member{agent})
		deadline := time.Now().Add(2 * time.Second)
		for {
			if found := noticeContaining(t, s, ch.ID, want); found {
				break
			}
			if time.Now().After(deadline) {
				t.Fatalf("no notice containing %q", want)
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
	runs, _ := s.Runs(ctx, ch.ID, "")
	if len(runs) != 0 {
		t.Fatalf("a rejected override started %d run(s)", len(runs))
	}
}

func noticeContaining(t *testing.T, s *store.Store, channelID, text string) bool {
	t.Helper()
	evs, err := s.EventsAfter(context.Background(), 0, 1000)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range evs {
		if e.Type == events.Notice && e.ChannelID == channelID && strings.Contains(string(e.Payload), text) {
			return true
		}
	}
	return false
}

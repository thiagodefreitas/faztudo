package app

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"

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

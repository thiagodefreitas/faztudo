package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/store"
)

func TestLaneHistoryEndpoint(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx := context.Background()
	if _, err := s.Append(ctx, events.Draft{Type: events.MemberUpdated, Actor: events.System, Payload: domain.Member{ID: "human", Kind: domain.MemberHuman, Handle: "you"}}); err != nil {
		t.Fatal(err)
	}
	lane := domain.Lane{ID: "a/b", CLI: "codex", Capacity: 1, Windows: []domain.LaneWindow{}}
	if _, err := s.Append(ctx, events.Draft{Type: events.LaneUpdated, Actor: events.System, Payload: lane}); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	reading := store.LaneUsageReading{LaneID: lane.ID, Window: domain.LaneWindow{Name: "5h", Source: domain.SourceProbe, MeasuredAt: &now}, ReadAt: now}
	if _, err := s.Append(ctx, events.Draft{Type: events.LaneUsageRead, Actor: events.System, Payload: reading}); err != nil {
		t.Fatal(err)
	}
	a := New(s, "human", "test")
	a.localAuthBypass = true
	r := httptest.NewRequest("GET", "http://127.0.0.1:7457/api/v1/lanes/a/b/history?window=5h", nil)
	r.RemoteAddr = "127.0.0.1:1234"
	w := httptest.NewRecorder()
	mux := http.NewServeMux()
	a.routes(mux)
	mux.ServeHTTP(w, r)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"lane_id":"a/b"`) {
		t.Fatalf("status %d body %s", w.Code, w.Body.String())
	}
}

func TestChannelSummaryCanOnlyBeRegeneratedByHuman(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx := context.Background()
	ch := domain.Channel{ID: "ch", Name: "work"}
	if _, err := s.Append(ctx, events.Draft{Type: events.ChannelCreated, Actor: events.System, ChannelID: ch.ID, Payload: ch}); err != nil {
		t.Fatal(err)
	}
	a := New(s, "human", "test")
	called := false
	a.RegenerateSummary = func(context.Context, string) (store.ChannelSummary, error) {
		called = true
		return store.ChannelSummary{ChannelID: ch.ID, Text: "summary"}, nil
	}
	r := httptest.NewRequest("POST", "/api/v1/lanes/channel-summary/ch/regenerate", nil)
	r.SetPathValue("channel_id", ch.ID)
	r = r.WithContext(context.WithValue(ctx, actorKey{}, domain.Member{ID: "agent", Kind: domain.MemberAgent}))
	w := httptest.NewRecorder()
	a.regenerateChannelSummary(w, r)
	if w.Code != 403 || called {
		t.Fatalf("agent status %d called %v", w.Code, called)
	}
	r = r.WithContext(context.WithValue(ctx, actorKey{}, domain.Member{ID: "human", Kind: domain.MemberHuman}))
	w = httptest.NewRecorder()
	a.regenerateChannelSummary(w, r)
	if w.Code != 200 || !called {
		t.Fatalf("human status %d called %v", w.Code, called)
	}
}

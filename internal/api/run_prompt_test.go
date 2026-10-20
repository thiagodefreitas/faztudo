package api

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/store"
)

func TestRunPromptRouteReturnsLatestAndMissing(t *testing.T) {
	ctx := context.Background()
	s, err := store.Open(filepath.Join(t.TempDir(), "db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	human := domain.Member{ID: "human", Kind: domain.MemberHuman, Handle: "human"}
	channel := domain.Channel{ID: "channel", Name: "channel", Kind: domain.ChannelTeam, Visibility: domain.VisibilityPublic, MemberIDs: []string{human.ID}}
	run := domain.Run{ID: "run", ChannelID: channel.ID, State: domain.RunQueued}
	for _, draft := range []events.Draft{
		{Type: events.MemberUpdated, Actor: events.System, Payload: human},
		{Type: events.ChannelCreated, Actor: events.System, ChannelID: channel.ID, Payload: channel},
		{Type: events.RunCreated, Actor: events.System, ChannelID: channel.ID, Payload: run},
	} {
		if _, err := s.Append(ctx, draft); err != nil {
			t.Fatal(err)
		}
	}
	h := newTestAPI(s, human.ID, "test")
	get := func() *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/api/v1/runs/run/prompt", nil)
		req.RemoteAddr = "127.0.0.1:1234"
		req.Host = "127.0.0.1"
		h.ServeHTTP(rec, req)
		return rec
	}
	if rec := get(); rec.Code != 404 {
		t.Fatalf("missing prompt status: %d %s", rec.Code, rec.Body.String())
	}
	for _, value := range []string{"first", "retry"} {
		if _, err := s.Append(ctx, events.Draft{Type: events.RunPrompt, Actor: events.System, ChannelID: channel.ID, Payload: events.RunPromptPayload{RunID: run.ID, Prompt: value}}); err != nil {
			t.Fatal(err)
		}
	}
	rec := get()
	if rec.Code != 200 {
		t.Fatalf("stored prompt status: %d %s", rec.Code, rec.Body.String())
	}
	var got events.RunPromptPayload
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil || got.Prompt != "retry" {
		t.Fatalf("latest prompt: %+v %v", got, err)
	}
}

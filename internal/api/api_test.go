package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/store"
)

type countTrigger struct{ count int }

func (t *countTrigger) OnMessage(context.Context, domain.Message, []domain.Member) { t.count++ }

func TestMessageStreamAndHumanApproval(t *testing.T) {
	ctx := context.Background()
	s, err := store.Open(filepath.Join(t.TempDir(), "db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	human := domain.Member{ID: store.NewID(), Kind: domain.MemberHuman, Handle: "user", DisplayName: "User"}
	agent := domain.Member{ID: store.NewID(), Kind: domain.MemberAgent, Handle: "codex", DisplayName: "Codex"}
	for _, m := range []domain.Member{human, agent} {
		if _, err = s.Append(ctx, events.Draft{Type: events.MemberUpdated, Actor: events.System, Payload: m}); err != nil {
			t.Fatal(err)
		}
	}
	h := New(s, human.ID, "test")
	trigger := &countTrigger{}
	h.Trigger = trigger
	srv := httptest.NewServer(h)
	defer srv.Close()
	req, _ := http.NewRequest("POST", srv.URL+"/api/v1/channels", bytes.NewBufferString(`{"name":"general","kind":"team","visibility":"public"}`))
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var ch domain.Channel
	json.NewDecoder(res.Body).Decode(&ch)
	res.Body.Close()
	if res.StatusCode != 201 {
		t.Fatalf("channel status %d", res.StatusCode)
	}
	ws, _, err := websocket.DefaultDialer.Dial("ws"+srv.URL[4:]+"/api/v1/stream", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	if err = ws.WriteMessage(websocket.TextMessage, []byte(`{"op":"subscribe","after_seq":0}`)); err != nil {
		t.Fatal(err)
	}
	req, _ = http.NewRequest("POST", srv.URL+"/api/v1/channels/"+ch.ID+"/messages", bytes.NewBufferString(`{"body":"hello @codex","idempotency_key":"same"}`))
	req.Header.Set("Content-Type", "application/json")
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var msg domain.Message
	json.NewDecoder(res.Body).Decode(&msg)
	res.Body.Close()
	if res.StatusCode != 201 || len(msg.Mentions) != 1 || msg.Mentions[0] != agent.ID {
		t.Fatalf("message %d %+v", res.StatusCode, msg)
	}
	if trigger.count != 1 {
		t.Fatalf("trigger count %d", trigger.count)
	}
	duplicateReq, _ := http.NewRequest("POST", srv.URL+"/api/v1/channels/"+ch.ID+"/messages", bytes.NewBufferString(`{"body":"hello @codex","idempotency_key":"same"}`))
	duplicateReq.Header.Set("Content-Type", "application/json")
	duplicateRes, err := http.DefaultClient.Do(duplicateReq)
	if err != nil {
		t.Fatal(err)
	}
	var duplicate domain.Message
	json.NewDecoder(duplicateRes.Body).Decode(&duplicate)
	duplicateRes.Body.Close()
	if duplicate.ID != msg.ID || trigger.count != 1 {
		t.Fatalf("duplicate retriggered: %+v count %d", duplicate, trigger.count)
	}
	ws.SetReadDeadline(time.Now().Add(3 * time.Second))
	var cursor int64
	for {
		_, b, e := ws.ReadMessage()
		if e != nil {
			t.Fatal(e)
		}
		var evt events.Event
		if json.Unmarshal(b, &evt) != nil {
			t.Fatal("invalid stream frame")
		}
		if evt.Type == events.MessagePosted {
			cursor = evt.Seq
			break
		}
	}
	ws.Close()
	req, _ = http.NewRequest("POST", srv.URL+"/api/v1/channels/"+ch.ID+"/messages", bytes.NewBufferString(`{"body":"second synthetic message"}`))
	req.Header.Set("Content-Type", "application/json")
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 201 {
		t.Fatal(res.StatusCode)
	}
	resumed, _, err := websocket.DefaultDialer.Dial("ws"+srv.URL[4:]+"/api/v1/stream", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer resumed.Close()
	sub, _ := json.Marshal(map[string]any{"op": "subscribe", "after_seq": cursor})
	if err = resumed.WriteMessage(websocket.TextMessage, sub); err != nil {
		t.Fatal(err)
	}
	resumed.SetReadDeadline(time.Now().Add(3 * time.Second))
	_, b, err := resumed.ReadMessage()
	if err != nil {
		t.Fatal(err)
	}
	var replay events.Event
	if err = json.Unmarshal(b, &replay); err != nil {
		t.Fatal(err)
	}
	if replay.Type != events.MessagePosted || replay.Seq <= cursor {
		t.Fatalf("resume: %+v", replay)
	}
	approval := domain.Approval{ID: store.NewID(), ChannelID: ch.ID, RequestedBy: agent.ID, Title: "Synthetic", State: domain.ApprovalPending, Options: []domain.ApprovalOption{{Key: "yes", Label: "Yes"}}}
	if _, err = s.Append(ctx, events.Draft{Type: events.ApprovalRequested, Actor: events.Agent(agent.ID), Payload: approval}); err != nil {
		t.Fatal(err)
	}
	req, _ = http.NewRequest("POST", srv.URL+"/api/v1/approvals/"+approval.ID+"/resolve", bytes.NewBufferString(`{"option":"yes"}`))
	req.RemoteAddr = "127.0.0.1:1234"
	req.Host = "127.0.0.1"
	req.Header.Set("Content-Type", "application/json")
	agentHandler := New(s, agent.ID, "test")
	rec := httptest.NewRecorder()
	agentHandler.ServeHTTP(rec, req)
	if rec.Code != 403 {
		t.Fatalf("agent approval: %d", rec.Code)
	}
}

func TestEndpointSurface(t *testing.T) {
	ctx := context.Background()
	s, err := store.Open(filepath.Join(t.TempDir(), "db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	human := domain.Member{ID: store.NewID(), Kind: domain.MemberHuman, Handle: "user", DisplayName: "User"}
	ch := domain.Channel{ID: store.NewID(), Name: "general", Kind: domain.ChannelTeam, Visibility: domain.VisibilityPublic, MemberIDs: []string{human.ID}}
	msg := domain.Message{ID: store.NewID(), ChannelID: ch.ID, AuthorID: human.ID, Body: "synthetic", CreatedAt: time.Now().UTC()}
	run := domain.Run{ID: store.NewID(), ChannelID: ch.ID, TriggerMessageID: msg.ID, AgentID: "agent", State: domain.RunQueued}
	approval := domain.Approval{ID: store.NewID(), ChannelID: ch.ID, Title: "Synthetic", State: domain.ApprovalPending, Options: []domain.ApprovalOption{{Key: "yes", Label: "Yes"}}}
	lane := domain.Lane{ID: "codex/default", CLI: "codex", Capacity: 1, Health: domain.LaneUnknown}
	for _, v := range []struct {
		typ     events.Type
		payload any
		channel string
	}{{events.MemberUpdated, human, ""}, {events.ChannelCreated, ch, ch.ID}, {events.MessagePosted, msg, ch.ID}, {events.RunCreated, run, ch.ID}, {events.ApprovalRequested, approval, ch.ID}, {events.LaneUpdated, lane, ""}} {
		if _, err = s.Append(ctx, events.Draft{Type: v.typ, Actor: events.System, ChannelID: v.channel, Payload: v.payload}); err != nil {
			t.Fatal(err)
		}
	}
	evts, err := s.EventsAfter(ctx, 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	h := New(s, human.ID, "test")
	cases := []struct {
		method, path, body string
		want               int
	}{
		{"GET", "/api/v1/health", "", 200}, {"GET", "/api/v1/me", "", 200}, {"GET", "/api/v1/members", "", 200}, {"GET", "/api/v1/channels", "", 200},
		{"PATCH", "/api/v1/channels/" + ch.ID, `{"topic":"Updated"}`, 200},
		{"GET", "/api/v1/channels/" + ch.ID + "/messages?limit=1", "", 200}, {"GET", "/api/v1/messages/" + msg.ID + "/thread", "", 200},
		{"POST", "/api/v1/channels/" + ch.ID + "/read", `{"event_id":"` + evts[2].ID + `"}`, 200},
		{"GET", "/api/v1/runs", "", 200}, {"GET", "/api/v1/runs/" + run.ID, "", 200}, {"GET", "/api/v1/runs/" + run.ID + "/output", "", 200},
		{"GET", "/api/v1/runs/" + run.ID + "/diff", "", 409}, {"POST", "/api/v1/runs/" + run.ID + "/cancel", "{}", 409}, {"POST", "/api/v1/runs/" + run.ID + "/retry", "{}", 409},
		{"GET", "/api/v1/approvals?state=pending", "", 200}, {"POST", "/api/v1/approvals/" + approval.ID + "/resolve", `{"option":"yes"}`, 200},
		{"GET", "/api/v1/lanes", "", 200}, {"PATCH", "/api/v1/lanes/codex/default", `{"capacity":2}`, 200}, {"POST", "/api/v1/lanes/codex/default/probe", "{}", 409},
	}
	for _, tc := range cases {
		t.Run(tc.method+" "+tc.path, func(t *testing.T) {
			req := httptest.NewRequest(tc.method, tc.path, bytes.NewBufferString(tc.body))
			req.RemoteAddr = "127.0.0.1:1234"
			req.Host = "127.0.0.1"
			if tc.body != "" {
				req.Header.Set("Content-Type", "application/json")
			}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code != tc.want {
				t.Fatalf("status %d, want %d: %s", rec.Code, tc.want, rec.Body.String())
			}
		})
	}
	req := httptest.NewRequest("GET", "/api/v1/me", nil)
	req.RemoteAddr = "192.0.2.1:1234"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 403 {
		t.Fatalf("remote accepted: %d", rec.Code)
	}
}

package mcp

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"

	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
)

// A project channel only lets assigned agents act. post_message must apply the
// same rule as the API: an unassigned mention posts the refusal notice and
// starts nothing.
func TestPostMessageHonorsProjectAssignments(t *testing.T) {
	ctx := context.Background()
	s := openStore(t)
	coder := domain.Member{ID: "coder", Kind: domain.MemberAgent, Handle: "coder", DisplayName: "Coder", Presence: domain.PresenceOnline}
	reviewer := domain.Member{ID: "reviewer", Kind: domain.MemberAgent, Handle: "reviewer", DisplayName: "Reviewer", Presence: domain.PresenceOnline}
	room := domain.Channel{ID: "room", Name: "faztudo-dev", Kind: domain.ChannelProject, Visibility: domain.VisibilityPublic}
	for _, d := range []events.Draft{
		{Type: events.MemberUpdated, Payload: coder},
		{Type: events.MemberUpdated, Payload: reviewer},
		{Type: events.ChannelCreated, ChannelID: room.ID, Payload: room},
		{Type: events.DepartmentUpdated, Payload: domain.Department{Handle: "engineering", DisplayName: "Engineering", Lead: "coder", Members: []string{"coder"}}},
		{Type: events.ProjectUpdated, Payload: domain.Project{Handle: "faztudo", Name: "Faztudo", Channels: []string{"faztudo-dev"}, Departments: []string{"engineering"}, Specialists: []string{}}},
	} {
		d.Actor = events.System
		if _, err := s.Append(ctx, d); err != nil {
			t.Fatal(err)
		}
	}
	trig := &recordTrigger{}
	h := New(s, trig)
	asCoder, err := h.Issue("run1", coder.ID, room.ID)
	if err != nil {
		t.Fatal(err)
	}
	asReviewer, err := h.Issue("run2", reviewer.ID, room.ID)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	fromCoder := connectMCP(t, srv.URL+"/mcp", asCoder)
	fromReviewer := connectMCP(t, srv.URL+"/mcp", asReviewer)

	call[messageOut](t, fromCoder, "post_message", map[string]any{"body": "@reviewer please look"})
	if trig.len() != 0 {
		t.Fatalf("an unassigned agent was started: %v", trig.calls)
	}
	evs, err := s.EventsAfter(ctx, 0, 500)
	if err != nil {
		t.Fatal(err)
	}
	var notice *events.NoticePayload
	for _, e := range evs {
		if e.Type != events.Notice || e.ChannelID != room.ID {
			continue
		}
		var n events.NoticePayload
		if err := json.Unmarshal(e.Payload, &n); err != nil {
			t.Fatal(err)
		}
		notice = &n
	}
	if notice == nil || notice.Action == nil || notice.Action.Kind != "assign" || notice.Action.Agent != "reviewer" || notice.Action.Project != "faztudo" {
		t.Fatalf("refusal notice %+v", notice)
	}

	call[messageOut](t, fromReviewer, "post_message", map[string]any{"body": "@coder ok, on it"})
	if got := trig.last(); len(got) != 1 || got[0] != coder.ID {
		t.Fatalf("assigned agent not started: %v", trig.calls)
	}
}

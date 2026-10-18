package mcp

import (
	"context"
	"testing"

	"github.com/thiagodefreitas/faztudo/internal/api"
	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
)

func TestPostUsesSharedPostAsWhenBound(t *testing.T) {
	ctx := context.Background()
	s := openStore(t)
	agent := domain.Member{ID: "agent", Kind: domain.MemberAgent, Handle: "coder"}
	if _, err := s.Append(ctx, events.Draft{Type: events.MemberUpdated, Actor: events.System, Payload: agent}); err != nil {
		t.Fatal(err)
	}
	h := New(s, nil)
	calls := 0
	h.PostAs = func(_ context.Context, actor events.Actor, author domain.Member, in api.PostInput) (domain.Message, bool, error) {
		calls++
		if actor != events.Agent(agent.ID) || author.ID != agent.ID || !in.AgentMessage || in.ChannelID != "room" || in.RunID != "run" || in.Body != "hello" {
			t.Fatalf("route: %s %+v %+v", actor, author, in)
		}
		return domain.Message{ID: "message"}, true, nil
	}
	m, err := h.postMessage(ctx, Grant{RunID: "run", AgentID: agent.ID, ChannelID: "room"}, "hello", "", nil, false, nil)
	if err != nil || m.ID != "message" || calls != 1 {
		t.Fatalf("post: %+v %v calls=%d", m, err, calls)
	}
}

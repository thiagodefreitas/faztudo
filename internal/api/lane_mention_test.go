package api

import (
	"context"
	"testing"

	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
)

// "/lane @coder <lane>" is the same channel command as "/lane coder <lane>".
// The mention must not suppress it, and it must start no agent.
func TestLaneCommandAcceptsLeadingMention(t *testing.T) {
	f := newThreadFixture(t)
	coder := f.coder
	coder.Agent = &domain.AgentInfo{Lanes: []string{"codex/default", "claude/default"}}
	if _, err := f.h.Store.Append(context.Background(), events.Draft{Type: events.MemberUpdated, Actor: events.System, Payload: coder}); err != nil {
		t.Fatal(err)
	}
	f.do(t, "POST", "/api/v1/channels/"+f.team.ID+"/messages", `{"body":"/lane @coder claude/default"}`, 201, nil)
	got, err := f.h.Store.Channel(context.Background(), f.team.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.LaneOverrides["coder"] != "claude/default" {
		t.Fatalf("override not stored: %v", got.LaneOverrides)
	}
	if f.trigger.count != 0 {
		t.Fatalf("the command started %d agent run(s)", f.trigger.count)
	}
}

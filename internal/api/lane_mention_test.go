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

func TestMentionLaneOverrideMessagesAreAcceptedAndForwarded(t *testing.T) {
	f := newThreadFixture(t)
	f.coder.Agent = &domain.AgentInfo{Lanes: []string{"claude/sonnet", "codex/default"}}
	if _, err := f.h.Store.Append(context.Background(), events.Draft{Type: events.MemberUpdated, Actor: events.System, Payload: f.coder}); err != nil {
		t.Fatal(err)
	}
	for i, body := range []string{
		"@coder /lane claude/opus do it",
		"@coder /lane unknown/model do it",
		"@coder /lane codex/default do it",
	} {
		var posted domain.Message
		f.do(t, "POST", "/api/v1/channels/"+f.team.ID+"/messages", `{"body":"`+body+`"}`, 201, &posted)
		if posted.Body != body || f.trigger.count != i+1 {
			t.Fatalf("message %q: posted %q, forwarded %d times", body, posted.Body, f.trigger.count)
		}
	}
}

package mcp

import (
	"context"
	"testing"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
)

// A collect run may not start agents: its post_message mentions do not fan
// out, so they cannot spend past the request budget.
func TestCollectRunMentionsDoNotFanOut(t *testing.T) {
	f := projectWorld(t)
	ctx := context.Background()
	digest := domain.Message{ID: "collect-msg", ChannelID: "room", ThreadID: f.root.ID, AuthorID: "chief", Body: "digest", Mentions: []string{}, CollectForRunID: "parent", CreatedAt: time.Now().UTC()}
	f.add(t, events.MessagePosted, "room", digest)
	f.add(t, events.RunCreated, "room", domain.Run{ID: "collect-run", ChannelID: "room", TriggerMessageID: digest.ID, AgentID: "chief", State: domain.RunQueued, Mode: domain.RunRead})
	f.add(t, events.RunCreated, "room", domain.Run{ID: "plain-run", ChannelID: "room", TriggerMessageID: f.root.ID, AgentID: "chief", State: domain.RunQueued, Mode: domain.RunRead})
	h := New(f.s, nil)
	if !h.collectRun(ctx, Grant{RunID: "collect-run"}) {
		t.Fatal("collect run not recognized")
	}
	if h.collectRun(ctx, Grant{RunID: "plain-run"}) {
		t.Fatal("plain run treated as collect")
	}
}

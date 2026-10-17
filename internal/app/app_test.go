package app

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/thiagodefreitas/faztudo/internal/config"
	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/store"
)

func TestNewRegistersAdditionalAdapters(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	a, err := New(context.Background(), s, config.Config{}, config.Paths{})
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"claude", "codex", "grok", "kimi", "agy", "opencode"} {
		adapter := a.Adapters[name]
		if adapter == nil || adapter.Name() != name {
			t.Fatalf("adapter %s: %v", name, adapter)
		}
	}
}

func TestCommitMessageEndsAtWordBoundary(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx := context.Background()
	c := domain.Channel{ID: "channel", Name: "work", Kind: domain.ChannelTeam, Visibility: domain.VisibilityPublic}
	m := domain.Message{ID: "message", ChannelID: c.ID, Body: "@coder Implement a synthetic improvement to the long running example without breaking words in the subject"}
	for _, d := range []events.Draft{{Type: events.ChannelCreated, Actor: events.System, ChannelID: c.ID, Payload: c}, {Type: events.MessagePosted, Actor: events.System, ChannelID: c.ID, Payload: m}} {
		if _, err := s.Append(ctx, d); err != nil {
			t.Fatal(err)
		}
	}
	a := App{Store: s}
	subject := strings.SplitN(a.commitMessage(ctx, domain.Run{ID: "run", TriggerMessageID: m.ID}), "\n", 2)[0]
	if len(subject) > 72 || strings.HasSuffix(subject, "...") || !strings.HasSuffix(subject, "without") {
		t.Fatalf("subject %d bytes: %q", len(subject), subject)
	}
}

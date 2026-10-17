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

func TestSplitCommit(t *testing.T) {
	for _, tc := range []struct{ name, answer, reply, proposal string }{
		{"none", "Done.", "Done.", ""},
		{"subject only", "Done.\n\nCOMMIT: Add the thing", "Done.", "Add the thing"},
		{"with body", "Done.\nCOMMIT: Add the thing\n\nIt helps.\nA second line.\n", "Done.", "Add the thing\n\nIt helps.\nA second line."},
		{"last block wins", "COMMIT: First\nmid\nCOMMIT: Second", "COMMIT: First\nmid", "Second"},
		{"not at line start", "see COMMIT: x", "see COMMIT: x", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			reply, proposal := splitCommit(tc.answer)
			if reply != tc.reply || proposal != tc.proposal {
				t.Fatalf("got %q, %q; want %q, %q", reply, proposal, tc.reply, tc.proposal)
			}
		})
	}
}

func TestBuildCommitMessage(t *testing.T) {
	for _, tc := range []struct{ name, proposal, trigger, want string }{
		{"proposal only", "Add the thing\n\nWhy.", "@coder do it", "Add the thing\n\nWhy.\n\nfaztudo run r1"},
		{"closes lines", "Add the thing", "@coder fix #41 and #42, see #41", "Add the thing\n\nCloses #41\nCloses #42\n\nfaztudo run r1"},
		{"already closed in body", "Add it\n\nCloses #41", "implement #41 and #7", "Add it\n\nCloses #41\n\nCloses #7\n\nfaztudo run r1"},
		{"fallback subject", "", "@coder tidy the docs for #3", "Tidy the docs for #3\n\nCloses #3\n\nfaztudo run r1"},
		{"fallback id", "", "", "Apply changes from faztudo run r1\n\nfaztudo run r1"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := buildCommitMessage(tc.proposal, tc.trigger, "r1"); got != tc.want {
				t.Fatalf("got %q; want %q", got, tc.want)
			}
		})
	}
}

func TestBuildCommitMessageDropsAttributionTrailers(t *testing.T) {
	got := buildCommitMessage("Add divide\n\nHandles zero.\nCo-Authored-By: Some Agent <agent@example.invalid>\nGenerated-By: tool", "@coder add divide", "r1")
	if strings.Contains(strings.ToLower(got), "co-authored-by") || strings.Contains(strings.ToLower(got), "generated-by") {
		t.Fatalf("trailer kept:\n%s", got)
	}
	if !strings.HasPrefix(got, "Add divide\n\nHandles zero.") {
		t.Fatalf("message:\n%s", got)
	}
}

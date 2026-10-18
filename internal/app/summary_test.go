package app

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/adapters"
	"github.com/thiagodefreitas/faztudo/internal/config"
	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/lanes"
	"github.com/thiagodefreitas/faztudo/internal/store"
)

func TestRolloverAtSixtyFivePercent(t *testing.T) {
	messages := []domain.Message{{Body: strings.Repeat("a", 160)}, {Body: strings.Repeat("b", 160)}, {Body: "latest"}}
	// 130 tokens, 84-token budget. The oldest item takes 56 tokens.
	got := rolloverMessages(messages, "summary", 130)
	if len(got) != 2 || got[0].Body != messages[1].Body {
		t.Fatalf("rollover: %+v", got)
	}
}

type summaryAdapter struct {
	name   string
	prompt *string
}

func (a summaryAdapter) Name() string { return a.name }
func (a summaryAdapter) Command(req adapters.Request) (adapters.Cmd, error) {
	*a.prompt = req.Prompt
	return adapters.Cmd{Path: "/bin/sh", Args: []string{"-c", "printf 'A short rolling summary'"}, Dir: req.Workdir}, nil
}
func (a summaryAdapter) Classify(int, string) (domain.FailureClass, adapters.LaneSignal, string) {
	return "", adapters.LaneSignal{}, ""
}

func TestRegenerateSummaryUsesCheapestAvailableLane(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx := context.Background()
	for _, lane := range []domain.Lane{
		{ID: "premium", CLI: "premium", CostClass: domain.CostPremium, Capacity: 1, Health: domain.LaneAvailable, Windows: []domain.LaneWindow{}},
		{ID: "cheap", CLI: "cheap", CostClass: domain.CostCheap, Capacity: 1, Health: domain.LaneAvailable, Windows: []domain.LaneWindow{}},
	} {
		if _, err := s.Append(ctx, events.Draft{Type: events.LaneUpdated, Actor: events.System, Payload: lane}); err != nil {
			t.Fatal(err)
		}
	}
	ch := domain.Channel{ID: "ch", Name: "work"}
	if _, err := s.Append(ctx, events.Draft{Type: events.ChannelCreated, Actor: events.System, ChannelID: ch.ID, Payload: ch}); err != nil {
		t.Fatal(err)
	}
	msg := domain.Message{ID: "one", ChannelID: ch.ID, AuthorID: "human", Body: "Decision: ship the smaller patch", CreatedAt: time.Now().UTC()}
	if _, err := s.Append(ctx, events.Draft{Type: events.MessagePosted, Actor: events.System, ChannelID: ch.ID, Payload: msg}); err != nil {
		t.Fatal(err)
	}
	reg, err := lanes.New([]lanes.LaneConfig{{ID: "premium", CLI: "premium", CostClass: domain.CostPremium, Capacity: 1}, {ID: "cheap", CLI: "cheap", CostClass: domain.CostCheap, Capacity: 1}}, nil, s)
	if err != nil {
		t.Fatal(err)
	}
	var prompt string
	a := App{Store: s, Config: config.Defaults(), Paths: config.Paths{DataDir: t.TempDir()}, Registry: reg, Adapters: map[string]adapters.Adapter{"cheap": summaryAdapter{name: "cheap", prompt: &prompt}}}
	got, err := a.RegenerateSummary(ctx, ch.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.LaneID != "cheap" || got.Text != "A short rolling summary" || !strings.Contains(prompt, msg.Body) {
		t.Fatalf("summary: %+v prompt %q", got, prompt)
	}
	stored, err := s.ChannelSummary(ctx, ch.ID)
	if err != nil || stored.ThroughMessageID != msg.ID {
		t.Fatalf("stored: %+v %v", stored, err)
	}
	for i := 2; i <= 85; i++ {
		next := domain.Message{ID: fmt.Sprintf("msg-%03d", i), ChannelID: ch.ID, AuthorID: "human", Body: fmt.Sprintf("fact %d", i), CreatedAt: msg.CreatedAt.Add(time.Duration(i) * time.Second)}
		if _, err := s.Append(ctx, events.Draft{Type: events.MessagePosted, Actor: events.System, ChannelID: ch.ID, Payload: next}); err != nil {
			t.Fatal(err)
		}
	}
	got, err = a.RegenerateSummary(ctx, ch.ID)
	if err != nil || got.ThroughMessageID != "msg-085" {
		t.Fatalf("batched summary: %+v %v", got, err)
	}
}

func TestPromptUsesSummaryAndOnlyLaterMessages(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx := context.Background()
	ch := domain.Channel{ID: "ch", Name: "work"}
	if _, err := s.Append(ctx, events.Draft{Type: events.ChannelCreated, Actor: events.System, ChannelID: ch.ID, Payload: ch}); err != nil {
		t.Fatal(err)
	}
	member := domain.Member{ID: "human", Kind: domain.MemberHuman, Handle: "you", DisplayName: "You"}
	if _, err := s.Append(ctx, events.Draft{Type: events.MemberUpdated, Actor: events.System, Payload: member}); err != nil {
		t.Fatal(err)
	}
	for i, body := range []string{"old detail", "new detail", "current request"} {
		msg := domain.Message{ID: []string{"one", "two", "three"}[i], ChannelID: ch.ID, AuthorID: member.ID, Body: body, CreatedAt: time.Now().UTC().Add(time.Duration(i) * time.Second)}
		if _, err := s.Append(ctx, events.Draft{Type: events.MessagePosted, Actor: events.System, ChannelID: ch.ID, Payload: msg}); err != nil {
			t.Fatal(err)
		}
	}
	summary := store.ChannelSummary{ChannelID: ch.ID, LaneID: "cheap", Text: "Earlier decision", ThroughMessageID: "one", UpdatedAt: time.Now().UTC()}
	if _, err := s.Append(ctx, events.Draft{Type: events.ChannelSummarized, Actor: events.System, ChannelID: ch.ID, Payload: summary}); err != nil {
		t.Fatal(err)
	}
	cfg := config.Defaults()
	cfg.Runs.SummaryEvery = 100
	a := App{Store: s, Config: cfg}
	text, err := a.prompt(ctx, domain.Message{ID: "three", ChannelID: ch.ID, Body: "current request"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(text, "Earlier decision") || !strings.Contains(text, "new detail") || strings.Contains(text, "old detail") {
		t.Fatalf("prompt: %s", text)
	}
}

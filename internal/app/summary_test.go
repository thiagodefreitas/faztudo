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

// writeOnlyAdapter refuses read-only commands, as agy does.
type writeOnlyAdapter struct{ summaryAdapter }

func (a writeOnlyAdapter) Command(req adapters.Request) (adapters.Cmd, error) {
	if req.Mode == domain.RunRead {
		return adapters.Cmd{}, fmt.Errorf("no read-only mode")
	}
	return a.summaryAdapter.Command(req)
}

func TestSummarySkipsLanesWithoutReadMode(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx := context.Background()
	configs := []lanes.LaneConfig{
		{ID: "cheap-write", CLI: "writeonly", CostClass: domain.CostCheap, Capacity: 1},
		{ID: "standard", CLI: "reader", CostClass: domain.CostStandard, Capacity: 1},
	}
	for _, c := range configs {
		lane := domain.Lane{ID: c.ID, CLI: c.CLI, CostClass: c.CostClass, Capacity: 1, Health: domain.LaneAvailable, Windows: []domain.LaneWindow{}}
		if _, err := s.Append(ctx, events.Draft{Type: events.LaneUpdated, Actor: events.System, Payload: lane}); err != nil {
			t.Fatal(err)
		}
	}
	ch := domain.Channel{ID: "ch", Name: "work"}
	if _, err := s.Append(ctx, events.Draft{Type: events.ChannelCreated, Actor: events.System, ChannelID: ch.ID, Payload: ch}); err != nil {
		t.Fatal(err)
	}
	msg := domain.Message{ID: "one", ChannelID: ch.ID, AuthorID: "human", Body: "Decision: keep the API small", CreatedAt: time.Now().UTC()}
	if _, err := s.Append(ctx, events.Draft{Type: events.MessagePosted, Actor: events.System, ChannelID: ch.ID, Payload: msg}); err != nil {
		t.Fatal(err)
	}
	reg, err := lanes.New(configs, nil, s)
	if err != nil {
		t.Fatal(err)
	}
	var prompt string
	a := App{Store: s, Config: config.Defaults(), Paths: config.Paths{DataDir: t.TempDir()}, Registry: reg, Adapters: map[string]adapters.Adapter{
		"writeonly": writeOnlyAdapter{summaryAdapter{name: "writeonly", prompt: &prompt}},
		"reader":    summaryAdapter{name: "reader", prompt: &prompt},
	}}
	got, err := a.RegenerateSummary(ctx, ch.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.LaneID != "standard" {
		t.Fatalf("summary lane = %q, want standard", got.LaneID)
	}
	if lane, _ := reg.Snapshot("cheap-write"); lane.RunsToday != 0 {
		t.Fatalf("write-only lane counted %d runs", lane.RunsToday)
	}
	if lane, _ := reg.Snapshot("standard"); lane.RunsToday != 1 {
		t.Fatalf("standard lane counted %d runs, want 1", lane.RunsToday)
	}
}

func TestResolveLaneName(t *testing.T) {
	agent := domain.Member{Handle: "coder", Agent: &domain.AgentInfo{Lanes: []string{"codex/default", "claude/sonnet", "agy/sonnet"}}}
	for in, want := range map[string]string{"codex": "codex/default", "claude": "claude/sonnet", "agy/sonnet": "agy/sonnet", "grok": "grok"} {
		if got, err := resolveLaneName(agent, in); err != nil || got != want {
			t.Fatalf("%s: %q %v", in, got, err)
		}
	}
	if _, err := resolveLaneName(agent, "sonnet"); err == nil || !strings.Contains(err.Error(), "claude/sonnet or agy/sonnet") {
		t.Fatalf("ambiguous: %v", err)
	}
}

// promptsAdapter records every prompt it is given.
type promptsAdapter struct {
	summaryAdapter
	prompts *[]string
}

func (a promptsAdapter) Command(req adapters.Request) (adapters.Cmd, error) {
	// summaryLane probes each adapter with a one-word prompt.
	if req.Prompt != "summary" {
		*a.prompts = append(*a.prompts, req.Prompt)
	}
	return a.summaryAdapter.Command(req)
}

func TestSummaryOfLongMessagesFitsOneArgument(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx := context.Background()
	lane := domain.Lane{ID: "cheap", CLI: "cheap", CostClass: domain.CostCheap, Capacity: 1, Health: domain.LaneAvailable, Windows: []domain.LaneWindow{}}
	if _, err := s.Append(ctx, events.Draft{Type: events.LaneUpdated, Actor: events.System, Payload: lane}); err != nil {
		t.Fatal(err)
	}
	ch := domain.Channel{ID: "ch", Name: "work"}
	if _, err := s.Append(ctx, events.Draft{Type: events.ChannelCreated, Actor: events.System, ChannelID: ch.ID, Payload: ch}); err != nil {
		t.Fatal(err)
	}
	start := time.Now().UTC()
	// Forty agent answers of 40 KB each: 1.6 MB, far over one argv string.
	for i := 1; i <= 40; i++ {
		msg := domain.Message{ID: fmt.Sprintf("msg-%03d", i), ChannelID: ch.ID, AuthorID: "agent", Body: fmt.Sprintf("answer %d ", i) + strings.Repeat("word ", 8000), CreatedAt: start.Add(time.Duration(i) * time.Second)}
		if _, err := s.Append(ctx, events.Draft{Type: events.MessagePosted, Actor: events.System, ChannelID: ch.ID, Payload: msg}); err != nil {
			t.Fatal(err)
		}
	}
	reg, err := lanes.New([]lanes.LaneConfig{{ID: "cheap", CLI: "cheap", CostClass: domain.CostCheap, Capacity: 1}}, nil, s)
	if err != nil {
		t.Fatal(err)
	}
	var last string
	var prompts []string
	a := App{Store: s, Config: config.Defaults(), Paths: config.Paths{DataDir: t.TempDir()}, Registry: reg, Adapters: map[string]adapters.Adapter{"cheap": promptsAdapter{summaryAdapter{name: "cheap", prompt: &last}, &prompts}}}
	got, err := a.RegenerateSummary(ctx, ch.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.ThroughMessageID != "msg-040" {
		t.Fatalf("summary stopped at %q", got.ThroughMessageID)
	}
	if len(prompts) < 2 {
		t.Fatalf("one pass for 1.6 MB of messages: %d", len(prompts))
	}
	for i, p := range prompts {
		if len(p) > adapters.MaxPromptBytes {
			t.Fatalf("prompt %d is %d bytes", i, len(p))
		}
	}
	if !strings.Contains(prompts[0], "answer 1 ") || !strings.Contains(prompts[len(prompts)-1], "answer 40 ") {
		t.Fatal("a pass skipped messages")
	}
}

func TestRolloverKeepsTranscriptUnderArgumentLimit(t *testing.T) {
	var messages []domain.Message
	for i := 0; i < 10; i++ {
		messages = append(messages, domain.Message{Body: strings.Repeat("x", 30<<10)})
	}
	messages = append(messages, domain.Message{Body: "latest"})
	for _, limit := range []int{0, 1_000_000} {
		got := rolloverMessages(messages, "summary", limit)
		size := 0
		for _, m := range got {
			size += len(m.Body)
		}
		if size > transcriptBytes || got[len(got)-1].Body != "latest" {
			t.Fatalf("limit %d kept %d bytes in %d messages", limit, size, len(got))
		}
	}
}

func TestOnlyAFailedSummaryCLIPausesTheChannel(t *testing.T) {
	ctx := context.Background()
	if summaryCostlyFailure(ctx, fmt.Errorf("%w: summary lane x unavailable", errNoSummaryLane)) {
		t.Fatal("a busy lane paused summaries")
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if summaryCostlyFailure(cancelled, context.Canceled) {
		t.Fatal("a cancelled request paused summaries")
	}
	if !summaryCostlyFailure(ctx, fmt.Errorf("exit status 1")) || summaryCostlyFailure(ctx, nil) {
		t.Fatal("a failed CLI must pause summaries, success must not")
	}
}

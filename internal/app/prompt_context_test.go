package app

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/config"
	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/store"
)

func TestPromptWorkingNowAndPins(t *testing.T) {
	ctx := context.Background()
	s, err := store.Open(filepath.Join(t.TempDir(), "db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	add := func(typ events.Type, payload any) {
		t.Helper()
		if _, err := s.Append(ctx, events.Draft{Type: typ, Actor: events.System, ChannelID: "ch", Payload: payload}); err != nil {
			t.Fatal(err)
		}
	}
	add(events.ChannelCreated, domain.Channel{ID: "ch", Name: "work"})
	add(events.MemberUpdated, domain.Member{ID: "agent", Handle: "coder", Kind: domain.MemberAgent})
	add(events.MemberUpdated, domain.Member{ID: "lead", Handle: "lead", Kind: domain.MemberAgent})
	now := time.Now().UTC()
	for _, m := range []domain.Message{
		{ID: "old", ChannelID: "ch", Body: strings.Repeat("p", 700), CreatedAt: now.Add(-2 * time.Minute)},
		{ID: "new", ChannelID: "ch", Body: "new pin", CreatedAt: now.Add(-time.Minute)},
		{ID: "other", ChannelID: "ch", Body: "edit owned files\nsecond line", CreatedAt: now},
		{ID: "self", ChannelID: "ch", Body: "my request", CreatedAt: now.Add(time.Second)},
	} {
		add(events.MessagePosted, m)
	}
	add(events.MessagePinned, domain.Pin{ChannelID: "ch", MessageID: "old", PinnedBy: "lead", PinnedAt: now.Add(-time.Minute)})
	add(events.MessagePinned, domain.Pin{ChannelID: "ch", MessageID: "new", PinnedBy: "lead", PinnedAt: now})
	add(events.RunCreated, domain.Run{ID: "active", ChannelID: "ch", TriggerMessageID: "other", AgentID: "agent", LaneID: "codex/default", Mode: domain.RunWrite, State: domain.RunRunning, StartedAt: &now})
	add(events.RunCreated, domain.Run{ID: "prompted", ChannelID: "ch", TriggerMessageID: "self", AgentID: "agent", Mode: domain.RunWrite, State: domain.RunQueued})
	add(events.RunCreated, domain.Run{ID: "finished", ChannelID: "ch", TriggerMessageID: "other", AgentID: "agent", State: domain.RunDone})
	add(events.HandoffCreated, events.HandoffPayload{Handoff: domain.Handoff{From: "lead", To: "coder"}, MessageID: "handoff", Task: "review API\nextra"})
	cfg := config.Defaults()
	cfg.Runs.SummaryEvery = 100
	cfg.Runs.ContextLimitTokens = 150
	a := App{Store: s, Config: cfg}
	text, err := a.promptForRun(ctx, domain.Message{ID: "self", ChannelID: "ch", Body: "my request"}, "prompted", domain.RunWrite)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"Working now:\n", "@coder", "codex/default", "write", "edit owned files", "@lead -> @coder: review API", "Pinned in this channel:\n", "new pin", "Keep to your own task and say which files you touched"} {
		if !strings.Contains(text, want) {
			t.Errorf("missing %q in %s", want, text)
		}
	}
	if strings.Contains(text, "run prompted") || strings.Contains(text, "run finished") {
		t.Errorf("listed self or terminal run: %s", text)
	}
	if strings.Index(text, "new pin") > strings.Index(text, strings.Repeat("p", 100)) {
		t.Error("pins are not newest first")
	}
	if strings.Contains(strings.Split(text, "Recent channel messages")[0], strings.Repeat("p", 650)) {
		t.Error("pin was not clipped")
	}
	if strings.Index(text, "Working now:") > strings.Index(text, "Recent channel messages") {
		t.Error("working section follows messages")
	}
	if strings.Contains(strings.Split(text, "Recent channel messages (oldest first)")[1], strings.Repeat("p", 100)) {
		t.Error("pin did not consume rolling message budget")
	}
	add(events.RunCreated, domain.Run{ID: "handoff-run", ChannelID: "ch", TriggerMessageID: "handoff", AgentID: "agent", State: domain.RunWaitingApproval})
	text, err = a.promptForRun(ctx, domain.Message{ID: "self", ChannelID: "ch", Body: "my request"}, "prompted", domain.RunRead)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(text, "handoff @lead -> @coder") {
		t.Error("waiting approval handoff must remain open")
	}
	add(events.RunUpdated, domain.Run{ID: "handoff-run", ChannelID: "ch", TriggerMessageID: "handoff", AgentID: "agent", State: domain.RunDone})
	add(events.RunUpdated, domain.Run{ID: "active", ChannelID: "ch", TriggerMessageID: "other", AgentID: "agent", State: domain.RunDone})
	text, err = a.promptForRun(ctx, domain.Message{ID: "self", ChannelID: "ch", Body: "my request"}, "prompted", domain.RunWrite)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(text, "Working now:") {
		t.Errorf("terminal runs and handoffs remain: %s", text)
	}
	for i := 0; i < 11; i++ {
		add(events.RunCreated, domain.Run{ID: fmt.Sprintf("run-%02d", i), ChannelID: "ch", TriggerMessageID: "other", AgentID: "agent", State: domain.RunRunning})
		add(events.HandoffCreated, events.HandoffPayload{Handoff: domain.Handoff{From: "lead", To: "coder"}, MessageID: fmt.Sprintf("piece-%02d", i), Task: fmt.Sprintf("piece %d", i)})
	}
	text, err = a.promptForRun(ctx, domain.Message{ID: "self", ChannelID: "ch", Body: "my request"}, "prompted", domain.RunRead)
	if err != nil {
		t.Fatal(err)
	}
	working := strings.Split(strings.Split(text, "Working now:\n")[1], "Pinned in this channel:")[0]
	if strings.Count(working, "- run ") != 10 || strings.Count(working, "- handoff ") != 10 || !strings.Contains(working, "and 1 more runs") || !strings.Contains(working, "and 1 more handoffs") {
		t.Errorf("working list caps: %s", working)
	}
	if !strings.Contains(working, "run-10") || strings.Contains(working, "run-00") || !strings.Contains(working, "piece 10\n") || strings.Contains(working, "piece 0\n") {
		t.Errorf("working list order: %s", working)
	}
}

func TestPromptContextEmptyAndCollect(t *testing.T) {
	ctx := context.Background()
	s, err := store.Open(filepath.Join(t.TempDir(), "db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if _, err := s.Append(ctx, events.Draft{Type: events.ChannelCreated, Actor: events.System, ChannelID: "ch", Payload: domain.Channel{ID: "ch", Name: "work"}}); err != nil {
		t.Fatal(err)
	}
	a := App{Store: s, Config: config.Defaults()}
	m := domain.Message{ID: "self", ChannelID: "ch", Body: "task"}
	text, err := a.promptForRun(ctx, m, "self-run", domain.RunRead)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(text, "Working now:") || strings.Contains(text, "Pinned in this channel:") {
		t.Fatalf("empty sections: %s", text)
	}
	now := time.Now().UTC()
	for _, draft := range []events.Draft{
		{Type: events.MessagePosted, Actor: events.System, ChannelID: "ch", Payload: domain.Message{ID: "pin", ChannelID: "ch", Body: "pinned plan", CreatedAt: now}},
		{Type: events.MessagePinned, Actor: events.System, ChannelID: "ch", Payload: domain.Pin{ChannelID: "ch", MessageID: "pin", PinnedBy: "human", PinnedAt: now}},
		{Type: events.RunCreated, Actor: events.System, ChannelID: "ch", Payload: domain.Run{ID: "other", ChannelID: "ch", TriggerMessageID: "pin", State: domain.RunRunning}},
	} {
		if _, err := s.Append(ctx, draft); err != nil {
			t.Fatal(err)
		}
	}
	m.CollectForRunID = "parent"
	text, err = a.promptForRun(ctx, m, "self-run", domain.RunRead)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(text, "Working now:") || strings.Contains(text, "Pinned in this channel:") {
		t.Fatalf("collect sections: %s", text)
	}
}

func TestAttemptStoresExactPromptAndSections(t *testing.T) {
	ctx := context.Background()
	f := newRoutineFixture(t, config.Defaults(), domain.LaneAvailable, "")
	f.app.Config.Lanes.Persona = []config.Persona{{Handle: "coder", Instructions: "Explain choices briefly."}}
	f.app.Paths.RunsDir = filepath.Join(t.TempDir(), "runs")
	f.app.Runner.RunDir = f.app.Paths.RunsDir
	var sent string
	f.app.Adapters["codex"] = summaryAdapter{name: "codex", prompt: &sent}
	m := domain.Message{ID: "prompt-request", ChannelID: f.general.ID, AuthorID: f.human.ID, Body: "@coder explain café", CreatedAt: time.Now().UTC()}
	if _, err := f.s.Append(ctx, events.Draft{Type: events.MessagePosted, Actor: events.Human(f.human.ID), ChannelID: m.ChannelID, Payload: m}); err != nil {
		t.Fatal(err)
	}
	_ = f.app.attempt(ctx, m, f.coder, "", "", new(string), false, "")
	runs, err := f.s.Runs(ctx, m.ChannelID, "")
	if err != nil || len(runs) != 1 {
		t.Fatalf("runs: %+v %v", runs, err)
	}
	stored, err := f.s.RunPrompt(ctx, runs[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	promptEvents, err := f.s.EventsOfTypes(ctx, m.ChannelID, events.RunPrompt)
	if err != nil || len(promptEvents) != 1 {
		t.Fatalf("prompt events: %d %v", len(promptEvents), err)
	}
	if sent == "" || stored.Prompt != sent {
		t.Fatalf("stored prompt differs from CLI prompt: stored=%q sent=%q", stored.Prompt, sent)
	}
	if !strings.HasPrefix(stored.Prompt, "Standing instructions for this role:\nExplain choices briefly.\n\n") {
		t.Fatalf("missing standing instructions: %q", stored.Prompt)
	}
	total := 0
	covered := make([]bool, len(stored.Prompt))
	for _, section := range stored.Sections {
		if section.Name == "" {
			t.Fatal("unnamed section")
		}
		size := 0
		for _, span := range section.Spans {
			size += span.Bytes
			if span.Offset < 0 || span.Offset+span.Bytes > len(covered) {
				t.Fatalf("invalid span: %+v", span)
			}
			for i := span.Offset; i < span.Offset+span.Bytes; i++ {
				if covered[i] {
					t.Fatalf("byte %d covered twice", i)
				}
				covered[i] = true
			}
		}
		if section.Bytes != size {
			t.Fatalf("%s size %d, spans %d", section.Name, section.Bytes, size)
		}
		total += size
	}
	if total != len(stored.Prompt) {
		t.Fatalf("sections cover %d bytes, prompt has %d", total, len(stored.Prompt))
	}
}

func TestAttemptPreservesPrebuiltPromptSections(t *testing.T) {
	ctx := context.Background()
	f := newRoutineFixture(t, config.Defaults(), domain.LaneAvailable, "")
	f.app.Paths.RunsDir = filepath.Join(t.TempDir(), "runs")
	f.app.Runner.RunDir = f.app.Paths.RunsDir
	var sent string
	f.app.Adapters["codex"] = summaryAdapter{name: "codex", prompt: &sent}
	m := domain.Message{ID: "compare-request", ChannelID: f.general.ID, AuthorID: f.human.ID, Body: "@coder compare", CreatedAt: time.Now().UTC()}
	if _, err := f.s.Append(ctx, events.Draft{Type: events.MessagePosted, Actor: events.Human(f.human.ID), ChannelID: m.ChannelID, Payload: m}); err != nil {
		t.Fatal(err)
	}
	prompt, sections, err := f.app.promptPartsForRun(ctx, m, "", domain.RunRead, "coder")
	if err != nil {
		t.Fatal(err)
	}
	_ = f.app.attempt(ctx, m, f.coder, "", "", new(string), true, prompt, sections)
	runs, err := f.s.Runs(ctx, m.ChannelID, "")
	if err != nil || len(runs) != 1 {
		t.Fatalf("runs: %+v %v", runs, err)
	}
	stored, err := f.s.RunPrompt(ctx, runs[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Prompt != sent || len(stored.Sections) != len(sections) {
		t.Fatalf("prebuilt prompt sections lost: %+v", stored)
	}
	for i, section := range sections {
		if stored.Sections[i].Name != section.Name {
			t.Fatalf("section %d: %q, want %q", i, stored.Sections[i].Name, section.Name)
		}
	}
}

// A handoff that never started a run stops counting as open work after
// staleHandoff; one with a live run stays.
func TestPromptDropsStaleUnstartedHandoffs(t *testing.T) {
	ctx := context.Background()
	s, err := store.Open(filepath.Join(t.TempDir(), "db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	add := func(typ events.Type, payload any) {
		t.Helper()
		if _, err := s.Append(ctx, events.Draft{Type: typ, Actor: events.System, ChannelID: "ch", Payload: payload}); err != nil {
			t.Fatal(err)
		}
	}
	add(events.ChannelCreated, domain.Channel{ID: "ch", Name: "work"})
	add(events.HandoffCreated, events.HandoffPayload{Handoff: domain.Handoff{From: "lead", To: "coder"}, MessageID: "never", Task: "never started"})
	add(events.HandoffCreated, events.HandoffPayload{Handoff: domain.Handoff{From: "lead", To: "coder"}, MessageID: "live", Task: "still running"})
	add(events.RunCreated, domain.Run{ID: "r1", ChannelID: "ch", TriggerMessageID: "live", AgentID: "agent", State: domain.RunRunning})
	a := App{Store: s, Config: config.Defaults()}
	text, err := a.workingPrompt(ctx, "ch", "", domain.RunRead, map[string]string{})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(text, "never started") {
		t.Fatalf("a fresh handoff is open work: %s", text)
	}
	old := staleHandoff
	staleHandoff = -time.Second
	defer func() { staleHandoff = old }()
	text, err = a.workingPrompt(ctx, "ch", "", domain.RunRead, map[string]string{})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(text, "never started") || !strings.Contains(text, "still running") {
		t.Fatalf("stale handoff kept or live one dropped: %s", text)
	}
}

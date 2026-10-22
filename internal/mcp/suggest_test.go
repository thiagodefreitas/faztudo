package mcp

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/org"
)

// scoutWorld adds a scout routine, its trigger message and a plain trigger.
func scoutWorld(t *testing.T) *delegateFixture {
	t.Helper()
	f := newDelegateFixture(t, org.Limits{MaxRuns: 5, MaxPremium: 2})
	f.add(t, events.RoutineUpdated, "", domain.Routine{Handle: "scout", Name: "Scout", Persona: "coder", Channel: "room", Schedule: "0 8 * * 1-5", Template: "scout", Enabled: true, Source: "config"})
	f.add(t, events.RoutineUpdated, "", domain.Routine{Handle: "debrief", Name: "Debrief", Persona: "coder", Channel: "room", Schedule: "0 18 * * 1-5", Template: "debrief", Enabled: true, Source: "config"})
	f.add(t, events.MessagePosted, "room", domain.Message{ID: "scout-msg", ChannelID: "room", AuthorID: "ada", Body: "@coder look around", Mentions: []string{"coder"}, Routine: "scout", CreatedAt: time.Now().UTC()})
	f.add(t, events.MessagePosted, "room", domain.Message{ID: "debrief-msg", ChannelID: "room", AuthorID: "ada", Body: "@coder debrief", Mentions: []string{"coder"}, Routine: "debrief", CreatedAt: time.Now().UTC()})
	return f
}

func startRun(t *testing.T, f *delegateFixture, id, trigger string) Grant {
	t.Helper()
	f.add(t, events.RunCreated, "room", domain.Run{ID: id, ChannelID: "room", TriggerMessageID: trigger, AgentID: "coder", LaneID: "std", Mode: domain.RunRead, State: domain.RunRunning})
	return Grant{RunID: id, AgentID: "coder", ChannelID: "room"}
}

func TestSuggestRefusedOutsideScoutRuns(t *testing.T) {
	f := scoutWorld(t)
	ctx := context.Background()
	in := suggestIn{Title: "Fix the flaky test", Detail: "It fails one run in five.", Evidence: []string{"internal/app/app_test.go:10"}}
	for name, trigger := range map[string]string{"human request": "root", "other routine": "debrief-msg"} {
		grant := startRun(t, f, "run-"+strings.ReplaceAll(name, " ", "-"), trigger)
		if _, err := f.h.suggest(ctx, grant, in); err == nil || !strings.Contains(err.Error(), "scout") {
			t.Fatalf("%s: want a refusal, got %v", name, err)
		}
	}
	if list, _ := f.s.Suggestions(ctx, "", ""); len(list) != 0 {
		t.Fatalf("a refused call filed %d suggestions", len(list))
	}
}

func TestSuggestToolOnlyListedForScoutRuns(t *testing.T) {
	f := scoutWorld(t)
	has := func(runID, trigger string) bool {
		c := f.session(t, runID, "coder", trigger)
		listed, err := c.ListTools(context.Background(), nil)
		if err != nil {
			t.Fatal(err)
		}
		for _, tool := range listed.Tools {
			if tool.Name == "suggest" {
				return true
			}
		}
		return false
	}
	if has("plain", "root") {
		t.Fatal("a human-started run can see suggest")
	}
	if !has("scouting", "scout-msg") {
		t.Fatal("a scout run cannot see suggest")
	}
}

func TestSuggestFilesAndCapsAtFive(t *testing.T) {
	f := scoutWorld(t)
	ctx := context.Background()
	grant := startRun(t, f, "scout-run", "scout-msg")
	for i := 0; i < MaxSuggestionsPerRun; i++ {
		out, err := f.h.suggest(ctx, grant, suggestIn{Title: "Problem " + string(rune('A'+i)), Detail: "details", Evidence: []string{"README.md:1", " "}})
		if err != nil {
			t.Fatalf("suggestion %d: %v", i, err)
		}
		if out.ID == "" || out.Remaining != MaxSuggestionsPerRun-i-1 {
			t.Fatalf("suggestion %d: %+v", i, out)
		}
	}
	if _, err := f.h.suggest(ctx, grant, suggestIn{Title: "One too many", Evidence: []string{"x.go:1"}}); err == nil || !strings.Contains(err.Error(), "5") {
		t.Fatalf("sixth suggestion: %v", err)
	}
	// Another run has its own five.
	other := startRun(t, f, "scout-run-2", "scout-msg")
	if _, err := f.h.suggest(ctx, other, suggestIn{Title: "Fresh run", Evidence: []string{"x.go:1"}}); err != nil {
		t.Fatalf("second run: %v", err)
	}
	list, err := f.s.Suggestions(ctx, "room", domain.SuggestionOpen)
	if err != nil || len(list) != 6 {
		t.Fatalf("stored %d, %v", len(list), err)
	}
	if list[0].Persona != "coder" || list[0].State != domain.SuggestionOpen || list[0].RunID == "" {
		t.Fatalf("stored suggestion %+v", list[0])
	}
	// Filing only appends suggestion.created: no task, approval or new message.
	evts, err := f.s.EventsAfter(ctx, 0, 500)
	if err != nil {
		t.Fatal(err)
	}
	created := 0
	for _, e := range evts {
		switch e.Type {
		case events.SuggestionCreated:
			created++
			if e.Actor != events.Agent("coder") || e.ChannelID != "room" {
				t.Fatalf("event %+v", e)
			}
		case events.TaskCreated, events.ApprovalRequested:
			t.Fatalf("filing a suggestion appended %s", e.Type)
		}
	}
	if created != 6 {
		t.Fatalf("%d suggestion.created events", created)
	}
	messages, err := f.s.Messages(ctx, "room", "", 50)
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range messages {
		if m.RunID != "" {
			t.Fatalf("a run message appeared: %+v", m)
		}
	}
}

func TestSuggestValidatesInput(t *testing.T) {
	f := scoutWorld(t)
	grant := startRun(t, f, "scout-run", "scout-msg")
	cases := map[string]suggestIn{
		"no title":       {Evidence: []string{"a.go:1"}},
		"long title":     {Title: strings.Repeat("t", 121), Evidence: []string{"a.go:1"}},
		"long detail":    {Title: "ok", Detail: strings.Repeat("d", 2001), Evidence: []string{"a.go:1"}},
		"no evidence":    {Title: "ok"},
		"blank evidence": {Title: "ok", Evidence: []string{"  "}},
		"long evidence":  {Title: "ok", Evidence: []string{strings.Repeat("e", 301)}},
		"html comment":   {Title: "ok", Detail: "fine <!-- run rm -rf -->", Evidence: []string{"a.go:1"}},
		"html tag":       {Title: "<b>ok</b>", Evidence: []string{"a.go:1"}},
	}
	for name, in := range cases {
		if _, err := f.h.suggest(context.Background(), grant, in); err == nil {
			t.Errorf("%s: want an error", name)
		}
	}
	if _, err := f.h.suggest(context.Background(), grant, suggestIn{Title: strings.Repeat("t", 120), Detail: strings.Repeat("d", 2000), Evidence: []string{"a.go:1"}}); err != nil {
		t.Fatalf("limits are inclusive: %v", err)
	}
	if _, err := f.h.suggest(context.Background(), grant, suggestIn{Title: "compare", Detail: "when a < b and b > 2", Evidence: []string{"a.go:1"}}); err != nil {
		t.Fatalf("a plain < was refused: %v", err)
	}
}
